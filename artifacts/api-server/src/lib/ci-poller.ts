/**
 * MTOS Recursive CI Poller — v2
 *
 * State machine:
 *   IDLE → POLLING → CHANGE_DETECTED → ANALYZING → TESTING
 *   → AI_REVIEWING → RECURSION_GATE → (COMPLETE | RETRY | ABORT)
 *
 * On ABORT: auto-dispatches a self-heal session (Bitdeer AI diagnosis
 * becomes the session prompt so Jules has immediate context to fix).
 *
 * Detects:
 *   • Commit SHA changes on the target branch
 *   • Open / failing pull requests
 *   • Recent error spikes in audit_log
 *   • Endpoint health-check regressions
 *
 * AI Review uses Bitdeer planner (Nemotron-3-Super-120B) — BITDEER_API_KEY
 * env var or vault row is required; without it the AI step is skipped and
 * the cycle still runs health checks and audit logging.
 */

import { logger } from "./logger";
import { pool } from "@workspace/db";
import { _ciState } from "../routes/health";
import { BITDEER_BASE_URL, BITDEER_MODELS } from "./ai/bitdeer";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const MAX_CONSECUTIVE_FAILURES = 3;
const BASE = process.env["API_BASE_URL"] ?? "http://localhost:" + (process.env["PORT"] ?? "8080");
const CI_POLLER_TOKEN = process.env["CI_POLLER_TOKEN"] ?? process.env["MTOS_INTERNAL_API_TOKEN"] ?? "";
const GITHUB_TOKEN = process.env["GITHUB_TOKEN"] ?? "";
const GITHUB_REPO = "paisabrazilfl-cpu/mass-tort-os";
const GITHUB_BRANCH = process.env["CI_WATCH_BRANCH"] ?? "main";
const REASONING_HEADROOM = 1536;

function authHeaders(): Record<string, string> {
  return CI_POLLER_TOKEN ? { Authorization: `Bearer ${CI_POLLER_TOKEN}` } : {};
}

function githubHeaders(): Record<string, string> {
  return {
    "User-Agent": "MTOS-CI-Poller/2.0",
    Accept: "application/vnd.github.v3+json",
    ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
  };
}

// ── State ────────────────────────────────────────────────────────────────────
interface TestResult {
  endpoint: string;
  status: number;
  passed: boolean;
  latencyMs: number;
  error?: string;
}

interface PrInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  ciPassing: boolean | null;
}

interface CiState {
  state:
    | "IDLE"
    | "POLLING"
    | "CHANGE_DETECTED"
    | "ANALYZING"
    | "TESTING"
    | "AI_REVIEWING"
    | "RECURSION_GATE"
    | "COMPLETE"
    | "ABORT";
  iteration: number;
  consecutiveFailures: number;
  lastRunAt: Date | null;
  lastCommitSha: string | null;
  testResults: TestResult[];
  openPrs: PrInfo[];
  recentErrors: string[];
  aiDiagnosis: string | null;
  selfHealDispatched: boolean;
}

// ── GitHub helpers ─────────────────────────────────────────────────────────

async function getLatestCommitSha(): Promise<string | null> {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`,
      { headers: githubHeaders(), signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return null;
    const d = (await r.json()) as { sha?: string };
    return d?.sha?.slice(0, 8) ?? null;
  } catch {
    return null;
  }
}

async function getOpenPrs(): Promise<PrInfo[]> {
  if (!GITHUB_TOKEN) return [];
  try {
    const r = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/pulls?state=open&per_page=10`,
      { headers: githubHeaders(), signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return [];
    const prs = (await r.json()) as Array<{
      number: number;
      title: string;
      state: string;
      html_url: string;
    }>;
    return prs.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      url: p.html_url,
      ciPassing: null,
    }));
  } catch {
    return [];
  }
}

/** Fetch the combined CI status for each PR's head commit. */
async function enrichPrsWithCiStatus(prs: PrInfo[]): Promise<PrInfo[]> {
  if (!GITHUB_TOKEN || prs.length === 0) return prs;
  const results: PrInfo[] = [];
  for (const pr of prs.slice(0, 5)) {
    // limit to 5 to avoid rate limits
    try {
      const r = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/pulls/${pr.number}`,
        { headers: githubHeaders(), signal: AbortSignal.timeout(4000) },
      );
      if (!r.ok) { results.push(pr); continue; }
      const detail = (await r.json()) as { head?: { sha?: string } };
      const sha = detail.head?.sha;
      if (!sha) { results.push(pr); continue; }

      const sr = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/commits/${sha}/status`,
        { headers: githubHeaders(), signal: AbortSignal.timeout(4000) },
      );
      if (!sr.ok) { results.push(pr); continue; }
      const status = (await sr.json()) as { state?: string };
      results.push({ ...pr, ciPassing: status.state === "success" });
    } catch {
      results.push(pr);
    }
  }
  return results;
}

// ── Audit-log error scan ───────────────────────────────────────────────────

async function recentAuditErrors(windowMinutes = 30): Promise<string[]> {
  try {
    const result = await pool.query<{ action: string; details: unknown; created_at: Date }>(
      `SELECT action, details, created_at
         FROM audit_log
        WHERE action LIKE '%error%' OR action LIKE '%fail%' OR action LIKE '%ci.fail%'
          AND created_at > now() - INTERVAL '${windowMinutes} minutes'
        ORDER BY created_at DESC
        LIMIT 20`,
    );
    return result.rows.map(
      (r) => `[${r.action}] ${typeof r.details === "string" ? r.details : JSON.stringify(r.details)}`,
    );
  } catch {
    return [];
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function httpGet(
  path: string,
): Promise<{ status: number; body: unknown; latencyMs: number }> {
  const start = Date.now();
  try {
    const r = await fetch(BASE + path, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    return {
      status: 0,
      body: { error: String((err as Error).message).slice(0, 80) },
      latencyMs: Date.now() - start,
    };
  }
}

const PUBLIC_HEALTH_CHECKS: Array<{ path: string; label: string; mustReturn200: boolean }> = [
  { path: "/api/healthz", label: "health", mustReturn200: true },
];

const AUTHENTICATED_HEALTH_CHECKS: Array<{
  path: string;
  label: string;
  mustReturn200: boolean;
}> = [
  { path: "/api/automations/node-catalog", label: "node-catalog", mustReturn200: true },
  { path: "/api/automations", label: "automations-list", mustReturn200: true },
  { path: "/api/ocr/results", label: "ocr-results", mustReturn200: true },
  { path: "/api/ocr/queue-stats", label: "ocr-queue-stats", mustReturn200: true },
  {
    path: "/api/npi/search?npi_number=1245319599",
    label: "npi-search",
    mustReturn200: true,
  },
  { path: "/api/decision-engine/settings", label: "decision-engine", mustReturn200: true },
  { path: "/api/vendors", label: "vendors", mustReturn200: true },
  { path: "/api/users", label: "users", mustReturn200: true },
  { path: "/api/integrations", label: "integrations", mustReturn200: true },
  { path: "/api/admin/competitive-intel/config", label: "ci-config", mustReturn200: true },
  { path: "/api/admin/competitive-intel/watchlist", label: "ci-watchlist", mustReturn200: true },
  { path: "/api/admin/api-keys", label: "api-keys", mustReturn200: true },
  { path: "/api/news/mass-tort", label: "news", mustReturn200: false },
  { path: "/api/admin/self-heal", label: "self-heal", mustReturn200: false },
  { path: "/api/analytics/predictive/model", label: "praxis-model", mustReturn200: false },
];

function activeChecks(): Array<{ path: string; label: string; mustReturn200: boolean }> {
  return CI_POLLER_TOKEN
    ? [...PUBLIC_HEALTH_CHECKS, ...AUTHENTICATED_HEALTH_CHECKS]
    : PUBLIC_HEALTH_CHECKS;
}

async function runTestSuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const check of activeChecks()) {
    const { status, latencyMs } = await httpGet(check.path);
    const passed = check.mustReturn200 ? status === 200 : status >= 200 && status < 500;
    results.push({ endpoint: check.label, status, passed, latencyMs });
    if (latencyMs > 5000) {
      results.push({
        endpoint: `${check.label}-latency`,
        status,
        passed: false,
        latencyMs,
        error: `Slow: ${latencyMs}ms`,
      });
    }
  }
  return results;
}

// ── AI Review — real Bitdeer call ─────────────────────────────────────────

async function callBitdeerAiReview(prompt: string): Promise<string | null> {
  const apiKey = process.env["BITDEER_API_KEY"]?.trim();
  if (!apiKey) return null;

  const model = BITDEER_MODELS.planner; // Nemotron-3-Super-120B — best reasoning
  const maxTokens = 512 + REASONING_HEADROOM; // headroom for hidden chain-of-thought

  try {
    const resp = await fetch(`${BITDEER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are the MTOS CI reviewer. Given a set of failing endpoint checks and recent error logs, " +
              "diagnose the most likely root cause in 2-3 sentences, then list 1-3 concrete remediation steps. " +
              "Be specific: name the file, route, or config that is most likely broken. " +
              "If no information is actionable, say PASS.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status }, "CI poller AI review: Bitdeer returned non-2xx");
      return null;
    }

    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const text = json?.choices?.[0]?.message?.content?.trim() ?? "";
    return text || null;
  } catch (err) {
    logger.warn({ err }, "CI poller AI review: Bitdeer call failed");
    return null;
  }
}

function buildAiPrompt(state: CiState): string {
  const failed = state.testResults.filter((r) => !r.passed);
  const lines: string[] = [
    `## CI Run #${state.iteration} — commit ${state.lastCommitSha ?? "unknown"}`,
    "",
    "### Failing endpoint checks",
    ...failed.map((f) => `- ${f.endpoint}: HTTP ${f.status}${f.error ? ` (${f.error})` : ""}`),
    "",
  ];
  if (state.openPrs.length > 0) {
    lines.push("### Open PRs");
    for (const pr of state.openPrs) {
      const ciTag =
        pr.ciPassing === true ? "✅ CI passing" : pr.ciPassing === false ? "❌ CI failing" : "? CI unknown";
      lines.push(`- PR #${pr.number}: "${pr.title}" [${ciTag}]`);
    }
    lines.push("");
  }
  if (state.recentErrors.length > 0) {
    lines.push("### Recent audit log errors (last 30 min)");
    lines.push(...state.recentErrors.slice(0, 10).map((e) => `- ${e}`));
    lines.push("");
  }
  lines.push(
    "Diagnose root cause and list specific remediation steps for the MTOS API server.",
  );
  return lines.join("\n");
}

// ── Auto self-heal dispatch ────────────────────────────────────────────────

async function dispatchSelfHeal(diagnosis: string, state: CiState): Promise<void> {
  if (!CI_POLLER_TOKEN) {
    logger.warn("CI poller: no CI_POLLER_TOKEN — cannot dispatch self-heal session");
    return;
  }
  const failed = state.testResults.filter((r) => !r.passed).map((r) => r.endpoint);
  const body = {
    prompt: [
      `## Auto-dispatched by CI Poller — iteration ${state.iteration}`,
      `Commit: ${state.lastCommitSha ?? "unknown"}`,
      `Consecutive failures: ${state.consecutiveFailures}`,
      "",
      `### Failing checks`,
      ...failed.map((e) => `- ${e}`),
      "",
      `### AI Diagnosis`,
      diagnosis,
      "",
      "Please fix the root cause described above and open a PR.",
    ].join("\n"),
    title: `[CI Auto] ${failed.slice(0, 3).join(", ")} — commit ${state.lastCommitSha ?? "?"}`,
  };
  try {
    const r = await fetch(`${BASE}/api/admin/self-heal`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CI_POLLER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      logger.info({ iteration: state.iteration }, "CI poller: self-heal session dispatched");
    } else {
      const txt = await r.text().catch(() => "");
      logger.warn({ status: r.status, body: txt.slice(0, 200) }, "CI poller: self-heal dispatch returned non-2xx");
    }
  } catch (err) {
    logger.warn({ err }, "CI poller: self-heal dispatch failed");
  }
}

// ── Recursion gate ────────────────────────────────────────────────────────

function recursionGate(
  state: CiState,
  failedCount: number,
): "RETRY" | "ABORT" | "COMPLETE" {
  if (state.testResults.length > 0 && failedCount === 0) return "COMPLETE";
  if (state.consecutiveFailures + 1 >= MAX_CONSECUTIVE_FAILURES) return "ABORT";
  return "RETRY";
}

// ── Audit writer ──────────────────────────────────────────────────────────

async function auditCiRun(state: CiState): Promise<void> {
  try {
    const passed = state.testResults.filter((r) => r.passed).length;
    const total = state.testResults.length;
    const failures = state.testResults.filter((r) => !r.passed).map((r) => r.endpoint);
    await pool
      .query(
        `INSERT INTO audit_log (entity_type, entity_id, action, details, created_at)
         VALUES ($1, $2, $3, $4, now())`,
        [
          "ci_poller",
          "system",
          failures.length === 0 ? "ci.pass" : "ci.fail",
          JSON.stringify({
            iteration: state.iteration,
            passed,
            total,
            failures,
            commit_sha: state.lastCommitSha,
            state: state.state,
            open_prs: state.openPrs.length,
            ai_diagnosis: state.aiDiagnosis ? state.aiDiagnosis.slice(0, 500) : null,
          }),
        ],
      )
      .catch((err) => {
        logger.error({ err }, "auditCiRun: insert failed");
      });
  } catch (err) {
    logger.error({ err }, "auditCiRun: failed (non-fatal)");
  }
}

// ── Shared state ──────────────────────────────────────────────────────────

let cycleInFlight = false;

let ciState: CiState = {
  state: "IDLE",
  iteration: 0,
  consecutiveFailures: 0,
  lastRunAt: null,
  lastCommitSha: null,
  testResults: [],
  openPrs: [],
  recentErrors: [],
  aiDiagnosis: null,
  selfHealDispatched: false,
};

// ── Main cycle ────────────────────────────────────────────────────────────

async function runCiCycle(): Promise<void> {
  if (cycleInFlight) {
    logger.warn("CI: previous cycle still running — skipping overlapping tick");
    return;
  }
  cycleInFlight = true;

  try {
    // ── POLLING ──────────────────────────────────────────────────────────
    ciState.state = "POLLING";
    ciState.iteration++;

    const [currentSha, openPrs, recentErrors] = await Promise.all([
      getLatestCommitSha(),
      getOpenPrs(),
      recentAuditErrors(30),
    ]);

    ciState.recentErrors = recentErrors;

    const enrichedPrs = await enrichPrsWithCiStatus(openPrs);
    ciState.openPrs = enrichedPrs;

    const commitChanged = currentSha && currentSha !== ciState.lastCommitSha;
    if (commitChanged) {
      ciState.state = "CHANGE_DETECTED";
      logger.info(
        { commit: currentSha, prev: ciState.lastCommitSha, openPrs: enrichedPrs.length },
        "CI: commit change detected",
      );
      ciState.lastCommitSha = currentSha;
      // Reset dispatch flag on new commit so a fresh failure triggers a new session
      ciState.selfHealDispatched = false;
    }

    // ── ANALYZING ────────────────────────────────────────────────────────
    ciState.state = "ANALYZING";
    const failingPrs = enrichedPrs.filter((p) => p.ciPassing === false);
    if (failingPrs.length > 0) {
      logger.warn({ prs: failingPrs.map((p) => p.number) }, "CI: PRs with failing CI detected");
    }

    // ── TESTING ──────────────────────────────────────────────────────────
    ciState.state = "TESTING";
    ciState.testResults = await runTestSuite();
    ciState.lastRunAt = new Date();

    const failed = ciState.testResults.filter((r) => !r.passed);
    const passed = ciState.testResults.filter((r) => r.passed);

    // ── AI_REVIEWING ─────────────────────────────────────────────────────
    ciState.state = "AI_REVIEWING";
    ciState.aiDiagnosis = null;

    if (failed.length > 0 || recentErrors.length > 0) {
      const prompt = buildAiPrompt(ciState);
      logger.info({ failedCount: failed.length, errorCount: recentErrors.length }, "CI: calling AI reviewer");
      const diagnosis = await callBitdeerAiReview(prompt);
      if (diagnosis) {
        ciState.aiDiagnosis = diagnosis;
        logger.info({ diagnosis: diagnosis.slice(0, 300) }, "CI: AI diagnosis");
      } else {
        logger.info("CI: AI review skipped (no BITDEER_API_KEY or call failed)");
      }
    }

    if (failed.length > 0) {
      logger.warn(
        {
          failed: failed.map((f) => f.endpoint),
          passed: passed.length,
          total: ciState.testResults.length,
        },
        "CI: test failures detected",
      );
    }

    // ── RECURSION_GATE ────────────────────────────────────────────────────
    ciState.state = "RECURSION_GATE";
    const decision = recursionGate(ciState, failed.length);

    if (decision === "COMPLETE") {
      ciState.consecutiveFailures = 0;
      ciState.state = "COMPLETE";
      logger.info(
        { passed: passed.length, total: ciState.testResults.length, commit: currentSha },
        "CI: COMPLETE — all tests pass",
      );
    } else if (decision === "ABORT") {
      ciState.consecutiveFailures++;
      ciState.state = "ABORT";
      logger.error(
        {
          failures: failed.map((f) => f.endpoint),
          consecutiveFailures: ciState.consecutiveFailures,
          aiDiagnosis: ciState.aiDiagnosis?.slice(0, 200),
        },
        "CI: ABORT — consecutive failure threshold reached",
      );

      // Auto-dispatch self-heal with AI diagnosis when not already dispatched
      if (!ciState.selfHealDispatched) {
        const selfHealPrompt =
          ciState.aiDiagnosis ??
          `Endpoints failing: ${failed.map((f) => f.endpoint).join(", ")}. Investigate and fix.`;
        await dispatchSelfHeal(selfHealPrompt, ciState);
        ciState.selfHealDispatched = true;
      }
    } else {
      // RETRY
      ciState.consecutiveFailures++;
      ciState.state = "IDLE";
      logger.info(
        {
          consecutiveFailures: ciState.consecutiveFailures,
          failed: failed.map((f) => f.endpoint),
        },
        "CI: RETRY — scheduling next poll",
      );
    }

    // ── Sync shared state store for /admin/ci-status ─────────────────────
    Object.assign(_ciState, {
      state: ciState.state,
      iteration: ciState.iteration,
      consecutiveFailures: ciState.consecutiveFailures,
      lastRunAt: ciState.lastRunAt?.toISOString() ?? null,
      lastCommitSha: ciState.lastCommitSha,
      passed: passed.length,
      total: ciState.testResults.length,
      failed: failed.map((r) => r.endpoint),
      openPrs: ciState.openPrs.length,
      failingPrs: failingPrs.map((p) => p.number),
      aiDiagnosis: ciState.aiDiagnosis?.slice(0, 500) ?? null,
      selfHealDispatched: ciState.selfHealDispatched,
    });

    await auditCiRun(ciState);
  } finally {
    cycleInFlight = false;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function startCiPoller(): void {
  logger.info(
    "CI Poller v2 starting — IDLE→POLLING→CHANGE_DETECTED→ANALYZING→TESTING→AI_REVIEWING→RECURSION_GATE",
  );
  // 30s boot delay so DB/migrations finish before first poll
  setTimeout(() => {
    runCiCycle().catch((err) => logger.error({ err }, "CI poller cycle error"));
  }, 30_000);

  setInterval(() => {
    runCiCycle().catch((err) => logger.error({ err }, "CI poller cycle error"));
  }, POLL_INTERVAL_MS);
}
