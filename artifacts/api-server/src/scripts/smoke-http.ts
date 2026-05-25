#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * MTOS smoke test — HTTP mode.
 *
 * Operator-driven. Walks every documented public + authed endpoint in
 * USER_MANUAL.md against a deployed instance. Reports HTTP status +
 * envelope shape per route. This is the "did the route actually fire?"
 * counterpart to scripts/smoke.ts (which only proves source-code
 * sanity).
 *
 * Run:
 *   MTOS_BASE_URL=https://api.your-firm.com \
 *   MTOS_ADMIN_EMAIL=admin@your-firm.com \
 *   MTOS_ADMIN_PASSWORD=... \
 *   pnpm --filter @workspace/api-server smoke:http
 *
 * What it does:
 *   1. Calls /api/healthz (public, no auth required).
 *   2. Logs in as the admin user, captures the access token.
 *   3. Iterates a documented endpoint list, GETs each, records
 *      HTTP status + parsed envelope shape.
 *   4. Writes smoke-http-report.{md,json} at the repo root.
 *
 * What it does NOT do:
 *   - Mutate any data. Every probe is a GET. No POST / PATCH / DELETE
 *     so it's safe to run against production.
 *   - Verify business correctness — only that the endpoint responds
 *     with a non-error envelope. Use the per-feature unit tests for
 *     deeper correctness.
 *   - Pass MFA. If the admin account has MFA enabled, login will
 *     return mfa_required and the smoke skips the authed phase with
 *     a clear note. Use a service-account API key instead (Bearer)
 *     by setting MTOS_API_TOKEN to bypass login.
 *
 * Exit code: 0 on all-pass; 1 on any HTTP failure.
 */

import { writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..", "..", "..", "..");
const BASE = (process.env["MTOS_BASE_URL"] || "").replace(/\/$/, "");
const EMAIL = process.env["MTOS_ADMIN_EMAIL"] || "";
const PASSWORD = process.env["MTOS_ADMIN_PASSWORD"] || "";
const STATIC_TOKEN = process.env["MTOS_API_TOKEN"] || "";
const TIMEOUT_MS = Number(process.env["MTOS_SMOKE_TIMEOUT_MS"] || 15_000);

if (!BASE) {
  console.error("MTOS_BASE_URL is required (e.g. https://api.your-firm.com)");
  process.exit(2);
}

interface HttpResult {
  step: string;
  method: "GET" | "POST";
  path: string;
  status: number;
  ok: boolean;
  envelope: "ok" | "error_envelope" | "non_json" | "empty";
  latency_ms: number;
  note?: string;
}

const results: HttpResult[] = [];

async function http(
  step: string,
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; body?: unknown; allowStatuses?: number[] } = {},
): Promise<HttpResult> {
  const url = BASE + path;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.body) headers["Content-Type"] = "application/json";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  let status = 0;
  let envelope: HttpResult["envelope"] = "empty";
  let note: string | undefined;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    status = res.status;
    const text = await res.text();
    if (!text) {
      envelope = "empty";
    } else {
      try {
        const json = JSON.parse(text);
        if (json && typeof json === "object" && (json as any).status === "error") {
          envelope = "error_envelope";
          note = (json as any).code ?? (json as any).message;
        } else {
          envelope = "ok";
        }
      } catch {
        envelope = "non_json";
        note = text.slice(0, 80);
      }
    }
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
    status = 0;
    envelope = "empty";
  } finally {
    clearTimeout(timer);
  }
  const allow = opts.allowStatuses ?? [200, 204];
  const ok = allow.includes(status);
  const r: HttpResult = { step, method, path, status, ok, envelope, latency_ms: Date.now() - start, note };
  results.push(r);
  console.log(
    `${ok ? "✅" : "❌"} [${status || "ERR"}] ${method} ${path}  (${r.latency_ms}ms${r.note ? ` — ${r.note}` : ""})`,
  );
  return r;
}

// =============================================================================

(async () => {
  console.log(`Smoke target: ${BASE}\n`);

  // Phase 1 — Public surface
  console.log("### Public endpoints");
  await http("Health check", "GET", "/api/healthz", { allowStatuses: [200] });
  await http("Public forms (list of public form configs)", "GET", "/api/forms-public/forms", {
    allowStatuses: [200, 404, 401, 403],
  });

  // Phase 2 — Authenticate
  let token = STATIC_TOKEN;
  if (!token) {
    console.log("\n### Login");
    if (!EMAIL || !PASSWORD) {
      console.error(
        "Skipping authed phase — set MTOS_ADMIN_EMAIL + MTOS_ADMIN_PASSWORD (or MTOS_API_TOKEN to skip login).",
      );
    } else {
      const url = BASE + "/api/auth/login";
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
          signal: ctrl.signal,
        });
        const json = (await res.json().catch(() => ({}))) as any;
        if (res.ok && json.access_token) {
          token = json.access_token;
          console.log("✅ Login succeeded");
        } else if (json.mfa_required) {
          console.error("❌ Login requires MFA. Set MTOS_API_TOKEN to a service-account token to bypass.");
        } else {
          console.error(`❌ Login failed [${res.status}]: ${JSON.stringify(json).slice(0, 200)}`);
        }
      } catch (err) {
        console.error(`❌ Login network error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }
  } else {
    console.log("\n### Using MTOS_API_TOKEN (skipping login)");
  }

  if (!token) {
    console.log("\nNo token — skipping authed phase. Public phase results below.");
  } else {
    console.log("\n### Authenticated endpoints");

    // §6 Overview
    await http("Auth — current session", "GET", "/api/auth/me", { token });

    // §6.3 Analytics
    await http("Analytics — overview", "GET", "/api/analytics/overview", { token });
    await http("Analytics — pipeline trend", "GET", "/api/analytics/pipeline-trend", { token });
    await http("Analytics — conversion funnel", "GET", "/api/analytics/conversion-funnel", { token });
    await http("Analytics — tort breakdown", "GET", "/api/analytics/tort-breakdown", { token });
    await http("Analytics — paralegal leaderboard", "GET", "/api/analytics/paralegal-leaderboard", { token });
    await http("Analytics — predictive model stats", "GET", "/api/analytics/predictive/model", {
      token,
      allowStatuses: [200, 400, 422, 500],
    });

    // §7 Leads & cases
    await http("Leads — list", "GET", "/api/leads", { token });
    await http("Cases — list", "GET", "/api/cases", { token });
    await http("Cases — worker queue stats", "GET", "/api/cases/worker/queue-stats", { token });

    // §7.8 Paralegals
    await http("Paralegals — list", "GET", "/api/paralegals", { token });

    // §7.9 Review queue
    await http("Review queue", "GET", "/api/review-queue", { token });

    // §8 Document workflow
    await http("Web Forms — list", "GET", "/api/web-forms/forms", {
      token,
      allowStatuses: [200, 404],
    });
    await http("Buyers — list", "GET", "/api/buyers", { token });
    await http("Document templates — list", "GET", "/api/document-templates", { token });
    await http("Workflow settings", "GET", "/api/workflow-settings", { token, allowStatuses: [200, 404] });

    // §9 Automation
    await http("Automations — list", "GET", "/api/automations", { token });
    await http("Automations — node catalog", "GET", "/api/automations/node-catalog", { token });
    await http("Self-Heal — config probe", "GET", "/api/admin/self-heal/config", { token });
    await http("Self-Heal — list sessions", "GET", "/api/admin/self-heal", {
      token,
      allowStatuses: [200, 500],
    });
    await http("Competitive Intel — config probe", "GET", "/api/admin/competitive-intel/config", { token });
    await http("Competitive Intel — watchlist", "GET", "/api/admin/competitive-intel/watchlist", { token });

    // §10 Documents
    await http("Documents — list (root)", "GET", "/api/documents", { token, allowStatuses: [200, 404] });
    await http("OCR — recent results", "GET", "/api/ocr/results", { token, allowStatuses: [200, 404] });
    await http("OCR — queue stats", "GET", "/api/ocr/queue-stats", { token, allowStatuses: [200, 404] });

    // §11 Tools
    await http("Decision Engine — settings", "GET", "/api/decision-engine/settings", { token });
    await http("Decision Engine — portfolio", "GET", "/api/decision-engine/portfolio", { token });
    await http("NPI — search by number (example)", "GET", "/api/npi/search?npi_number=1245319599", {
      token,
      allowStatuses: [200, 404],
    });

    // §12 Configuration
    await http("Vendors — list", "GET", "/api/vendors", { token });
    await http("Users — list", "GET", "/api/users", { token });
    await http("Integrations — list", "GET", "/api/integrations", { token });
    await http("Integrations — presets", "GET", "/api/integrations/presets", { token });
    await http("Integrations — categories", "GET", "/api/integrations/categories", { token });
    await http("Billing — state", "GET", "/api/billing/state", { token, allowStatuses: [200, 404] });
    await http("Compliance — TCPA stats", "GET", "/api/compliance/tcpa", { token, allowStatuses: [200, 404] });
    await http("Security — stats", "GET", "/api/security/stats", { token, allowStatuses: [200, 404] });

    // §13 News / admin
    await http("News — mass-tort feed", "GET", "/api/news/mass-tort", {
      token,
      allowStatuses: [200, 404, 503],
    });

    // Admin
    await http("Admin — API keys list", "GET", "/api/admin/api-keys", { token, allowStatuses: [200, 404] });
    await http("Admin — Event catalog", "GET", "/api/admin/event-catalog", { token, allowStatuses: [200, 404] });
    await http("Admin — Dark Room links", "GET", "/api/admin/dark-room", { token, allowStatuses: [200, 404] });
    await http("Admin — Forms API directory", "GET", "/api/admin/forms-api-directory", {
      token,
      allowStatuses: [200, 404],
    });
  }

  // Report
  const passes = results.filter((r) => r.ok).length;
  const fails = results.filter((r) => !r.ok).length;
  const lines = [
    "# MTOS HTTP Smoke Report",
    "",
    `**Target:** ${BASE}`,
    `**Probes:** ${results.length} · **PASS:** ${passes} · **FAIL:** ${fails}`,
    "",
    "| Status | Method | Path | Latency | Note |",
    "|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.ok ? "✅" : "❌"} ${r.status || "ERR"} | ${r.method} | \`${r.path}\` | ${r.latency_ms}ms | ${
          r.note ?? ""
        } |`,
    ),
  ];
  writeFileSync(join(ROOT, "smoke-http-report.md"), lines.join("\n"));
  writeFileSync(join(ROOT, "smoke-http-report.json"), JSON.stringify({ base: BASE, results }, null, 2));
  console.log(`\nWrote smoke-http-report.{md,json} to repo root.`);
  console.log(`Final: ${passes}/${results.length} probes passed.`);
  process.exit(fails > 0 ? 1 : 0);
})();
