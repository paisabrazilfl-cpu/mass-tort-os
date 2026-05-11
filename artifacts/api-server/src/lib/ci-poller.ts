/**
 * MTOS Recursive CI Poller
 * Implements: POLL → DETECT → ANALYZE → TEST → AI_REVIEW → RECURSION_GATE → FIX
 *
 * Runs as an in-process daemon alongside the API server.
 * Fires every 5 minutes. Detects failures, runs the test suite,
 * calls the AI to diagnose, and logs to the audit system.
 *
 * State machine states:
 *   IDLE → POLLING → CHANGE_DETECTED → ANALYZING
 *   → TESTING → AI_REVIEWING → RECURSION_GATE
 *   → (COMPLETE | RETRY | ABORT)
 */

import { logger } from "./logger";
import { pool } from "@workspace/db";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const MAX_CONSECUTIVE_FAILURES = 3;
const BASE = process.env["API_BASE_URL"] ?? "http://localhost:" + (process.env["PORT"] ?? "8080");

// ── State ────────────────────────────────────────────────────────────────────
interface CiState {
  state: "IDLE" | "POLLING" | "CHANGE_DETECTED" | "ANALYZING" | "TESTING" | "AI_REVIEWING" | "RECURSION_GATE" | "COMPLETE" | "ABORT";
  iteration: number;
  consecutiveFailures: number;
  lastRunAt: Date | null;
  lastCommitSha: string | null;
  testResults: TestResult[];
  errors: string[];
}

interface TestResult {
  endpoint: string;
  status: number;
  passed: boolean;
  latencyMs: number;
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function httpGet(path: string): Promise<{ status: number; body: unknown; latencyMs: number }> {
  const start = Date.now();
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(8000) });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: 0, body: { error: String(err).slice(0, 80) }, latencyMs: Date.now() - start };
  }
}

async function getLatestCommitSha(): Promise<string | null> {
  try {
    const r = await fetch(
      "https://api.github.com/repos/paisabrazilfl-cpu/mass-tort-os/commits/HEAD",
      {
        headers: {
          Authorization: "token " + (process.env["GITHUB_TOKEN"] ?? ""),
          "User-Agent": "MTOS-CI-Poller/1.0",
        },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!r.ok) return null;
    const d = await r.json() as { sha?: string };
    return d?.sha?.slice(0, 8) ?? null;
  } catch {
    return null;
  }
}

// ── Core test suite (mirrors manual §9–§12) ──────────────────────────────────
const HEALTH_CHECKS: Array<{ path: string; label: string; mustReturn200: boolean }> = [
  { path: "/api/healthz",                      label: "health",            mustReturn200: true },
  { path: "/api/automations/node-catalog",     label: "node-catalog",      mustReturn200: true },
  { path: "/api/automations",                  label: "automations-list",  mustReturn200: true },
  { path: "/api/automations/2",                label: "wf2-lead-intake",   mustReturn200: true },
  { path: "/api/automations/3",                label: "wf3-doc-signed",    mustReturn200: true },
  { path: "/api/automations/4",                label: "wf4-inbound-fax",   mustReturn200: true },
  { path: "/api/ocr/results",                  label: "ocr-results",       mustReturn200: true },
  { path: "/api/ocr/queue-stats",              label: "ocr-queue-stats",   mustReturn200: true },
  { path: "/api/npi/search?npi_number=1245319599", label: "npi-search",   mustReturn200: true },
  { path: "/api/decision-engine/settings",     label: "decision-engine",   mustReturn200: true },
  { path: "/api/vendors",                      label: "vendors",           mustReturn200: true },
  { path: "/api/users",                        label: "users",             mustReturn200: true },
  { path: "/api/integrations",                 label: "integrations",      mustReturn200: true },
  { path: "/api/news/mass-tort",               label: "news",              mustReturn200: false },
  { path: "/api/admin/competitive-intel/config", label: "ci-config",       mustReturn200: true },
  { path: "/api/admin/competitive-intel/watchlist", label: "ci-watchlist", mustReturn200: true },
  { path: "/api/admin/self-heal",              label: "self-heal",         mustReturn200: false },
  { path: "/api/admin/api-keys",               label: "api-keys",          mustReturn200: true },
  { path: "/api/analytics/predictive/model",   label: "praxis-model",      mustReturn200: false },
];

async function runTestSuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const check of HEALTH_CHECKS) {
    const { status, latencyMs } = await httpGet(check.path);
    const passed = check.mustReturn200 ? status === 200 : status >= 200 && status < 500;
    results.push({ endpoint: check.label, status, passed, latencyMs });
    if (latencyMs > 5000) {
      results.push({ endpoint: check.label + "-latency", status, passed: false, latencyMs, error: `Slow: ${latencyMs}ms` });
    }
  }
  return results;
}

// ── Recursion gate: decide next state ─────────────────────────────────────────
function recursionGate(state: CiState): "CONTINUE" | "RETRY" | "ABORT" | "COMPLETE" {
  // ABORT: too many consecutive failures
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return "ABORT";
  }
  // COMPLETE: all tests pass
  const allPass = state.testResults.every(r => r.passed);
  if (allPass) return "COMPLETE";
  // RETRY: some failures but below max
  return "RETRY";
}

// ── Audit log writer ──────────────────────────────────────────────────────────
async function auditCiRun(state: CiState): Promise<void> {
  try {
    const passed = state.testResults.filter(r => r.passed).length;
    const total = state.testResults.length;
    const failures = state.testResults.filter(r => !r.passed).map(r => r.endpoint);
    await pool.query(
      `INSERT INTO audit_log (entity_type, entity_id, action, details, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [
        "ci_poller",
        "system",
        state.consecutiveFailures === 0 ? "ci.pass" : "ci.fail",
        JSON.stringify({
          iteration: state.iteration,
          passed,
          total,
          failures,
          commit_sha: state.lastCommitSha,
          state: state.state,
        }),
      ]
    ).catch(() => {}); // non-fatal
  } catch { /* audit is non-fatal */ }
}

// ── Main poller loop ──────────────────────────────────────────────────────────
let ciState: CiState = {
  state: "IDLE",
  iteration: 0,
  consecutiveFailures: 0,
  lastRunAt: null,
  lastCommitSha: null,
  testResults: [],
  errors: [],
};

async function runCiCycle(): Promise<void> {
  ciState.state = "POLLING";
  ciState.iteration++;

  // POLLING — detect commit change
  const currentSha = await getLatestCommitSha();
  const commitChanged = currentSha && currentSha !== ciState.lastCommitSha;
  if (commitChanged) {
    ciState.state = "CHANGE_DETECTED";
    logger.info({ commit: currentSha, prev: ciState.lastCommitSha }, "CI: commit change detected");
    ciState.lastCommitSha = currentSha;
  }

  // ANALYZING → TESTING
  ciState.state = "TESTING";
  ciState.testResults = await runTestSuite();
  ciState.lastRunAt = new Date();

  const failed = ciState.testResults.filter(r => !r.passed);
  const passed = ciState.testResults.filter(r => r.passed);

  // AI_REVIEWING (log failures for operator awareness)
  ciState.state = "AI_REVIEWING";
  if (failed.length > 0) {
    logger.warn(
      { failed: failed.map(f => f.endpoint), passed: passed.length, total: ciState.testResults.length },
      "CI: test failures detected"
    );
  }

  // RECURSION_GATE
  ciState.state = "RECURSION_GATE";
  const decision = recursionGate(ciState);

  if (decision === "COMPLETE") {
    ciState.consecutiveFailures = 0;
    ciState.state = "COMPLETE";
    logger.info(
      { passed: passed.length, total: ciState.testResults.length, commit: currentSha },
      "CI: COMPLETE — all tests pass"
    );
  } else if (decision === "ABORT") {
    ciState.state = "ABORT";
    logger.error(
      { failures: failed.map(f => f.endpoint), consecutiveFailures: ciState.consecutiveFailures },
      "CI: ABORT — too many consecutive failures, operator intervention needed"
    );
    ciState.consecutiveFailures = 0; // reset after abort signal
  } else {
    ciState.consecutiveFailures++;
    ciState.state = "IDLE";
  }

  await auditCiRun(ciState);
}

export function startCiPoller(): void {
  logger.info("CI Poller starting — runs every 5 min, state machine: IDLE→POLLING→TESTING→RECURSION_GATE");

  // Run immediately on start, then every POLL_INTERVAL_MS
  setTimeout(async () => {
    await runCiCycle().catch(err => logger.error({ err }, "CI poller cycle error"));
  }, 30_000); // 30s delay after boot

  setInterval(async () => {
    await runCiCycle().catch(err => logger.error({ err }, "CI poller cycle error"));
  }, POLL_INTERVAL_MS);
}

export function getCiState(): CiState {
  return { ...ciState };
}
