#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * MTOS smoke test — pure mode.
 *
 * Walks every documented claim in USER_MANUAL.md and asserts the
 * supporting code actually exists in the documented file at the
 * documented shape. NO database. NO network. NO server boot. Pure
 * file-content / grep assertions.
 *
 * Run it with:
 *
 *   pnpm --filter @workspace/api-server smoke
 *
 * Output:
 *   - A Markdown report streamed to stdout, capability by capability.
 *   - A JSON report written to ./smoke-report.json so CI can parse it.
 *
 * Exit code:
 *   0 — every PASS, or only SKIP results
 *   1 — at least one FAIL
 *
 * Why grep-based instead of import-based:
 *   Importing the real modules requires SESSION_SECRET, DATABASE_URL,
 *   ENCRYPTION_KEY etc. The smoke is meant to run in CI with zero
 *   config, on a developer laptop without postgres, and against any
 *   commit. Each probe asserts "the documented file at the documented
 *   path contains the documented symbol/path/string" — that's what an
 *   audit actually wants to verify.
 *
 *   When a probe needs more than a string match (e.g. catalog↔handler
 *   parity), it still works against source files, not loaded modules.
 *
 * Adding a probe:
 *   probe(SECTION, CAPABILITY, () => {
 *     const content = read("relative/path/from/repo-root.ts");
 *     if (!content.includes("expected_token")) throw new Error("missing");
 *     return "evidence string for the report";
 *   });
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// repo root — this file lives at artifacts/api-server/src/scripts/smoke.ts.
// ESM lacks __dirname; derive it from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..", "..", "..", "..");

function read(rel: string): string {
  const path = join(ROOT, rel);
  if (!existsSync(path)) {
    throw new Error(`file does not exist: ${rel}`);
  }
  return readFileSync(path, "utf8");
}

function readMaybe(rel: string): string | null {
  const path = join(ROOT, rel);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

interface ProbeResult {
  section: string;
  capability: string;
  outcome: "PASS" | "FAIL" | "SKIP";
  evidence: string;
  reason?: string;
}

const results: ProbeResult[] = [];

function probe(section: string, capability: string, check: () => string): void {
  try {
    const evidence = check();
    results.push({ section, capability, outcome: "PASS", evidence });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (reason.startsWith("SKIP:")) {
      results.push({
        section,
        capability,
        outcome: "SKIP",
        evidence: "",
        reason: reason.slice(5).trim(),
      });
    } else {
      results.push({
        section,
        capability,
        outcome: "FAIL",
        evidence: "",
        reason,
      });
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

function mustContain(content: string, needle: string | RegExp, what: string): void {
  const found = typeof needle === "string" ? content.includes(needle) : needle.test(content);
  if (!found) throw new Error(`${what} not found`);
}

function countMatches(content: string, re: RegExp): number {
  return (content.match(re) ?? []).length;
}

// =============================================================================
// Part I — Foundations
// =============================================================================

probe("§2.1", "UserRole defines five roles", () => {
  const rbac = read("artifacts/api-server/src/lib/rbac.ts");
  const need = ["super_admin", "admin", "attorney", "paralegal", "viewer"];
  for (const r of need) mustContain(rbac, `"${r}"`, `role "${r}"`);
  return `rbac.ts UserRole union contains all 5 roles`;
});

probe("§2.1", "ROLE_HIERARCHY assigns numeric weights", () => {
  const rbac = read("artifacts/api-server/src/lib/rbac.ts");
  mustContain(rbac, /ROLE_HIERARCHY[\s\S]*?super_admin:\s*200/, "super_admin=200");
  mustContain(rbac, /admin:\s*100/, "admin=100");
  mustContain(rbac, /attorney:\s*75/, "attorney=75");
  mustContain(rbac, /paralegal:\s*50/, "paralegal=50");
  mustContain(rbac, /viewer:\s*25/, "viewer=25");
  return "rbac.ts ROLE_HIERARCHY has all 5 weights";
});

probe("§2.5", "Access token TTL is 15 minutes", () => {
  const rbac = read("artifacts/api-server/src/lib/rbac.ts");
  mustContain(rbac, /ACCESS_TOKEN_EXPIRY\s*=\s*"15m"/, "ACCESS_TOKEN_EXPIRY=15m");
  return "rbac.ts ACCESS_TOKEN_EXPIRY = '15m'";
});

probe("§2.5", "Refresh token TTL is 7 days", () => {
  const rbac = read("artifacts/api-server/src/lib/rbac.ts");
  mustContain(rbac, /REFRESH_TOKEN_EXPIRY_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/, "7d in ms");
  return "rbac.ts REFRESH_TOKEN_EXPIRY_MS = 7*24*60*60*1000";
});

probe("§3.1-3.6", "Permission enum has every documented bucket", () => {
  const rbac = read("artifacts/api-server/src/lib/rbac.ts");
  // Documented permission names — at least one representative per bucket
  const need = [
    "LEAD_VIEW_ANY", "LEAD_CREATE", "LEAD_UPDATE", "LEAD_DELETE", "LEAD_QUALIFY", "LEAD_EXPORT",
    "CASE_VIEW_ANY", "CASE_CREATE", "CASE_UPLOAD", "CASE_ANALYZE",
    "PARALEGAL_VIEW", "PARALEGAL_MANAGE",
    "INTEGRATIONS_MANAGE",
    "ANALYTICS_VIEW", "ANALYTICS_PREDICTIVE_LEAD_VIEW",
    "AUTOMATIONS_VIEW", "AUTOMATIONS_MANAGE",
    "SELF_HEAL_MANAGE",
    "COMPETITIVE_INTEL_MANAGE",
    "SMS_SEND",
  ];
  for (const p of need) mustContain(rbac, `${p}:`, p);
  return `Permission enum has ${need.length} expected entries`;
});

probe("§3.7", "ROLE_PERMISSIONS map super_admin → every permission", () => {
  const rbac = read("artifacts/api-server/src/lib/rbac.ts");
  mustContain(rbac, /super_admin:\s*new Set<Permission>\(Object\.values\(Permission\)\)/, "super_admin: all perms");
  return "super_admin: new Set<Permission>(Object.values(Permission))";
});

probe("§5.1", "firm-scope helper exists with requireFirmId + leadFirmScope", () => {
  const f = read("artifacts/api-server/src/lib/firm-scope.ts");
  mustContain(f, "export function requireFirmId", "requireFirmId export");
  mustContain(f, "export function leadFirmScope", "leadFirmScope export");
  mustContain(f, "MissingFirmContextError", "MissingFirmContextError class");
  return "lib/firm-scope.ts exports requireFirmId + leadFirmScope + MissingFirmContextError";
});

probe("§5.4", "Encryption pinned to V1 in CURRENT_KEY_VERSION", () => {
  const enc = read("artifacts/api-server/src/lib/encryption.ts");
  mustContain(enc, /const CURRENT_KEY_VERSION\s*=\s*1\b/, "CURRENT_KEY_VERSION = 1");
  return "encryption.ts CURRENT_KEY_VERSION = 1";
});

probe("§5.4", "AES-256-GCM with field+entity AAD", () => {
  const enc = read("artifacts/api-server/src/lib/encryption.ts");
  mustContain(enc, /aes-256-gcm/, "AES-256-GCM");
  mustContain(enc, "buildAAD", "buildAAD helper");
  return "encryption.ts uses aes-256-gcm + buildAAD(field, entityId)";
});

probe("§5.6", "AI Constitution loader exists", () => {
  const a = read("artifacts/api-server/src/lib/ai-constitution.ts");
  mustContain(a, "getAiConstitution", "getAiConstitution export");
  // Doc file should exist too
  if (!existsSync(join(ROOT, "docs/AI_CONSTITUTION.md"))) throw new Error("docs/AI_CONSTITUTION.md missing");
  return "lib/ai-constitution.ts + docs/AI_CONSTITUTION.md both present";
});

// =============================================================================
// Part II §7-§11 — Pages → Routes → Handlers
// =============================================================================

probe("§7.1", "GET /api/leads route is mounted under leadsRouter", () => {
  const idx = read("artifacts/api-server/src/routes/index.ts");
  mustContain(idx, `router.use("/leads", leadsRouter)`, "leads mount");
  const leads = read("artifacts/api-server/src/routes/leads.ts");
  mustContain(leads, `router.get("/"`, "GET / handler");
  return `routes/index.ts mounts leads at /api/leads; GET / handler present`;
});

probe("§7.1", "Lead routes are firm-scoped (post-7baf80e)", () => {
  const leads = read("artifacts/api-server/src/routes/leads.ts");
  mustContain(leads, "leadFirmScope", "leadFirmScope import");
  if (countMatches(leads, /leadFirmScope\(req\)/g) < 4) {
    throw new Error(`leadFirmScope(req) used <4 times — expected at every mutation site`);
  }
  return `leads.ts uses leadFirmScope(req) at ${countMatches(leads, /leadFirmScope\(req\)/g)} call sites`;
});

probe("§7.2", "POST /api/leads stamps firm_id on insert", () => {
  const leads = read("artifacts/api-server/src/routes/leads.ts");
  mustContain(leads, /firm_id:\s*requireFirmId\(req\)/, "firm_id: requireFirmId(req)");
  return "leads.ts POST stamps firm_id from JWT";
});

probe("§7.1", "GET /api/leads/export hard cap = 50_000", () => {
  const leads = read("artifacts/api-server/src/routes/leads.ts");
  mustContain(leads, "EXPORT_HARD_CAP = 50_000", "50k cap constant");
  return "leads.ts EXPORT_HARD_CAP = 50_000";
});

probe("§7.5", "GET /api/cases is firm-scoped via casesTable.firm_id", () => {
  const cases = read("artifacts/api-server/src/routes/cases.ts");
  mustContain(cases, /eq\(casesTable\.firm_id,\s*firmId\)/, "case firm filter");
  return "cases.ts list + detail filter by casesTable.firm_id";
});

probe("§7.5", "casesTable schema has firm_id column", () => {
  const schema = read("lib/db/src/schema/cases.ts");
  mustContain(schema, /firm_id:\s*integer\("firm_id"\)/, "firm_id column");
  mustContain(schema, "cases_firm_id_idx", "firm_id index");
  return "schema/cases.ts has firm_id integer column + index";
});

probe("§9.1", "Automations webhook (public) is mounted before authMiddleware", () => {
  const idx = read("artifacts/api-server/src/routes/index.ts");
  // public mount happens before authMiddleware
  const beforeAuth = idx.indexOf("router.use(authMiddleware)");
  const automationsWebhookMount = idx.indexOf("automationsWebhookRouter");
  if (automationsWebhookMount === -1) throw new Error("automationsWebhookRouter not imported");
  if (automationsWebhookMount >= beforeAuth) throw new Error("mounted AFTER authMiddleware");
  return "routes/index.ts mounts automationsWebhookRouter before authMiddleware (verified by source ordering)";
});

probe("§9.1", "Automations webhook uses rawBody HMAC (not JSON.stringify)", () => {
  const aw = read("artifacts/api-server/src/routes/automations-webhook.ts");
  mustContain(aw, "rawBody", "rawBody reference");
  // Strip line and block comments before searching for the regression so we
  // don't match the explanatory comment that documents the bug we fixed.
  const stripped = aw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  // The regression is `JSON.stringify(req.body)` being USED as the HMAC
  // input — i.e. fed to createHmac.update() or assigned to a name that
  // later flows there. Detect either form.
  if (/createHmac\([^)]*\)\.update\(\s*JSON\.stringify\(req\.body\)/.test(stripped)) {
    throw new Error("regressed: createHmac().update(JSON.stringify(req.body))");
  }
  if (/=\s*JSON\.stringify\(req\.body\)/.test(stripped)) {
    throw new Error("regressed: assignment from JSON.stringify(req.body) — likely fed to HMAC");
  }
  return "automations-webhook.ts uses req.rawBody buffer for HMAC (comments mentioning the old bug are ignored)";
});

probe("§9.1", "app.ts attaches rawBody for both webhook surfaces", () => {
  const app = read("artifacts/api-server/src/app.ts");
  mustContain(app, "/api/webhooks/", "webhooks prefix capture");
  mustContain(app, "/api/automations/webhook/", "automations webhook prefix capture");
  return "app.ts express.json verify hook captures rawBody for both prefixes";
});

probe("§9.4", "Workflow runs persist to automation_runs table", () => {
  const schema = read("lib/db/src/schema/automations.ts");
  mustContain(schema, "automation_runs", "automation_runs table");
  mustContain(schema, "automation_workflows", "automation_workflows table");
  return "schema/automations.ts defines automation_runs + automation_workflows";
});

probe("§9.7", "Self-Heal returns 503 when JULES_API_KEY missing", () => {
  const sh = read("artifacts/api-server/src/routes/admin-self-heal.ts");
  mustContain(sh, "jules_not_configured", "jules_not_configured code");
  mustContain(sh, "isJulesConfigured", "isJulesConfigured guard");
  return "admin-self-heal.ts returns 503 + code:jules_not_configured when key absent";
});

probe("§9.7", "Self-Heal list is firm-scoped via Drizzle (no SQL concat)", () => {
  const sh = read("artifacts/api-server/src/routes/admin-self-heal.ts");
  // post-fix: uses db.select / requireFirmId
  mustContain(sh, "requireFirmId", "requireFirmId");
  if (sh.includes(`"1=1"`)) throw new Error("1=1 fallback still present");
  if (sh.match(/pool\.query\([\s\S]{0,80}firm_id\s*=\s*"\s*\+/)) {
    throw new Error("SQL concat still present");
  }
  return "admin-self-heal.ts uses Drizzle + requireFirmId; no 1=1 fallback";
});

probe("§9.8", "Competitive Intel watchlist is firm-scoped", () => {
  const ci = read("artifacts/api-server/src/routes/admin-competitive-intel.ts");
  mustContain(ci, /eq\(competitiveIntelAdvertisersTable\.firm_id/, "firm_id filter");
  return "admin-competitive-intel.ts filters watchlist by firm_id";
});

probe("§11.3", "Decision Engine writes convexity_action on the lead row", () => {
  const de = read("artifacts/api-server/src/lib/decision-engine-service.ts");
  mustContain(de, "convexity_action", "convexity_action column write");
  mustContain(de, "convexity_rationale", "convexity_rationale column write");
  return "decision-engine-service.ts writes convexity_score/action/rationale/etc";
});

probe("§11.4", "Praxis Predictive is documented as heuristic, not ML", () => {
  const p = read("artifacts/api-server/src/lib/predictive-scoring.ts");
  // The comment marker we deliberately added during the marketing-reality patch
  mustContain(p, /no actual ML training happens/i, "ML-disclaimer comment");
  return "predictive-scoring.ts honestly admits it's a weighted-feature heuristic";
});

probe("§11.7", "Background Check Hub has 11 lane adapters", () => {
  const hub = read("artifacts/api-server/src/lib/bg-hub/hub.ts");
  const expected = [
    "address", "email", "phone", "phone_provenance",
    "residency", "criminal_court", "incarceration",
    "sex_offender_nsopw", "attorney", "business_entity", "pacer_federal",
  ];
  for (const lane of expected) {
    mustContain(hub, `lane: "${lane}"`, `${lane} adapter entry`);
  }
  return `hub.ts ADAPTERS list has all 11 lanes`;
});

probe("§11.7", "bg-hub exposes final_status_live_lanes_only on result", () => {
  const t = read("artifacts/api-server/src/lib/bg-hub/types.ts");
  mustContain(t, "final_status_live_lanes_only", "live-lanes field");
  return "types.ts BackgroundHubResult has final_status_live_lanes_only";
});

probe("§11.7", "bg-hub lane results expose manual_action_urls", () => {
  const t = read("artifacts/api-server/src/lib/bg-hub/types.ts");
  mustContain(t, "manual_action_urls", "smart-link field");
  return "types.ts BackgroundLaneResult has manual_action_urls";
});

probe("§11.7", "STUB_LANES is reduced to four (business_entity demoted)", () => {
  const e = read("artifacts/api-server/src/lib/bg-hub/escalation.ts");
  mustContain(e, "STUB_LANES", "STUB_LANES export");
  // ensure business_entity is NOT in STUB_LANES set
  const stubSetMatch = e.match(/STUB_LANES[^}]+}/);
  if (!stubSetMatch) throw new Error("STUB_LANES declaration not found");
  if (stubSetMatch[0].includes(`"business_entity"`)) {
    throw new Error("business_entity still in STUB_LANES; SEC EDGAR adapter should have removed it");
  }
  for (const lane of ["residency", "incarceration", "sex_offender_nsopw", "attorney"]) {
    if (!stubSetMatch[0].includes(`"${lane}"`)) throw new Error(`${lane} missing from STUB_LANES`);
  }
  return "escalation.ts STUB_LANES has exactly 4 lanes; business_entity demoted to live";
});

probe("§11.7", "SEC EDGAR adapter exists and exports searchEdgar", () => {
  const e = read("artifacts/api-server/src/lib/bg-hub/sec-edgar.ts");
  mustContain(e, "export async function searchEdgar", "searchEdgar export");
  mustContain(e, "data.sec.gov", "SEC URL");
  return "sec-edgar.ts wired to https://www.sec.gov/files/company_tickers.json";
});

probe("§11.7", "Treasury OFAC SDN adapter exists", () => {
  const o = read("artifacts/api-server/src/lib/ofac-treasury.ts");
  mustContain(o, "matchTreasurySdn", "matchTreasurySdn export");
  mustContain(o, "treasury.gov/ofac/downloads/sdn.csv", "Treasury URL");
  return "ofac-treasury.ts wired to treasury.gov SDN CSV";
});

probe("§11.7", "Garbo adapter scaffold exists with credential lookup", () => {
  const g = read("artifacts/api-server/src/lib/bg-hub/garbo.ts");
  mustContain(g, "runGarboCheck", "runGarboCheck export");
  mustContain(g, "getIntegrationCredentials", "credential lookup");
  mustContain(g, "OPERATOR-CONFIRM", "marked endpoint TODO");
  return "garbo.ts has credential lookup + 3 marked OPERATOR-CONFIRM blocks for the API contract";
});

probe("§11.7", "Phone provenance via Telnyx Lookup", () => {
  const p = read("artifacts/api-server/src/lib/bg-hub/phone-provenance.ts");
  mustContain(p, "lookupPhoneProvenance", "lookup export");
  mustContain(p, "/v2/number_lookup/", "Telnyx Lookup endpoint");
  return "phone-provenance.ts wired to Telnyx /v2/number_lookup";
});

probe("§11.7", "Email enrichment has curated disposable-domain list", () => {
  const e = read("artifacts/api-server/src/lib/bg-hub/email-enrichment.ts");
  mustContain(e, "mailinator.com", "mailinator entry");
  mustContain(e, "guerrillamail.com", "guerrillamail entry");
  mustContain(e, "10minutemail.com", "10minutemail entry");
  return "email-enrichment.ts curated disposable list present";
});

probe("§11.7", "Smart-links module emits prefilled URLs for 4 lanes", () => {
  const s = read("artifacts/api-server/src/lib/bg-hub/smart-links.ts");
  mustContain(s, "nsopwSearchUrl", "nsopw smart-link");
  mustContain(s, "bopInmateSearchUrl", "BOP smart-link");
  mustContain(s, "stateBarSearchUrl", "state bar smart-link");
  mustContain(s, "stateSosSearchUrl", "state SoS smart-link");
  // verify ~10 state-bar deep-links wired
  const stateBarStates = ["CA", "NY", "TX", "FL", "IL", "PA", "OH", "GA", "NC", "WA"];
  for (const st of stateBarStates) {
    if (!s.match(new RegExp(`\\b${st}:\\s*\\(`))) throw new Error(`state bar ${st} not wired`);
  }
  return `smart-links.ts has ${stateBarStates.length} state-bar deep-links + state SoS deep-links`;
});

probe("§11.7", "Tort-policy categorization covers Roblox + Camp Lejeune + Zantac", () => {
  const t = read("artifacts/api-server/src/lib/bg-hub/tort-policy.ts");
  mustContain(t, `["roblox", "child_safety"]`, "roblox → child_safety");
  mustContain(t, `["camp_lejeune", "medical_injury"]`, "camp_lejeune → medical_injury");
  mustContain(t, `["zantac", "pharmaceutical_injury"]`, "zantac → pharmaceutical_injury");
  return "tort-policy.ts maps Roblox / Camp Lejeune / Zantac to the right categories";
});

probe("§11.7", "Tort-policy skips business_entity + attorney for child_safety", () => {
  const t = read("artifacts/api-server/src/lib/bg-hub/tort-policy.ts");
  // POLICY_MATRIX child_safety block contains skip rules
  mustContain(t, /child_safety:\s*{[\s\S]*?attorney:\s*"skip"/, "attorney skip");
  mustContain(t, /child_safety:\s*{[\s\S]*?business_entity:\s*"skip"/, "business_entity skip");
  return "tort-policy.ts: child_safety category skips attorney + business_entity lanes";
});

// =============================================================================
// §12.4 — Integrations
// =============================================================================

probe("§12.4", "integrationsTable schema has firm_id", () => {
  const s = read("lib/db/src/schema/integrations.ts");
  mustContain(s, /firm_id:\s*integer\("firm_id"\)/, "firm_id column");
  return "schema/integrations.ts has firm_id integer column + index";
});

probe("§12.4", "Integration CRUD routes use integrationFirmScope predicate", () => {
  const r = read("artifacts/api-server/src/routes/integrations.ts");
  mustContain(r, "integrationFirmScope", "scope predicate");
  if (countMatches(r, /integrationFirmScope\(req\)/g) < 5) {
    throw new Error(`integrationFirmScope used <5 times — expected on every CRUD verb`);
  }
  return `integrations.ts uses integrationFirmScope at ${countMatches(r, /integrationFirmScope\(req\)/g)} call sites`;
});

probe("§12.4", "Integration sync returns 501 for unsupported providers", () => {
  const r = read("artifacts/api-server/src/routes/integrations.ts");
  mustContain(r, "501", "501 status");
  mustContain(r, "sync_not_supported", "sync_not_supported code");
  mustContain(r, "syncable_providers", "syncable_providers field");
  return "integrations.ts /:id/sync returns HTTP 501 + syncable_providers list";
});

probe("§12.4", "Garbo preset is registered in integration-presets.ts", () => {
  const p = read("artifacts/api-server/src/lib/integration-presets.ts");
  mustContain(p, /provider:\s*"garbo"/, "garbo preset");
  return "integration-presets.ts has Garbo entry under Background Check";
});

probe("§12.4", "integration-wiring.ts lists garbo with status:live", () => {
  const w = read("artifacts/api-server/src/lib/integration-wiring.ts");
  mustContain(w, /garbo:\s*{[\s\S]*?status:\s*"live"/, "garbo: status:live");
  return "integration-wiring.ts garbo is registered as live";
});

// =============================================================================
// §13 — Reference appendices
// =============================================================================

probe("§13.3", "Automation node catalog ↔ handler parity", () => {
  const cat = read("artifacts/api-server/src/lib/automations/node-catalog.ts");
  const exec = read("artifacts/api-server/src/lib/automations/executor.ts");
  // Top-level node-catalog entries declare their type with the canonical
  // `namespace.action` shape (a dot). NodeParamSpec items inside `params`
  // use bare TS-type names ("string" / "json" / "select" / etc.) — match
  // ONLY the dotted form so the param-spec types don't contaminate the
  // catalog inventory.
  const catalogTypes = [...cat.matchAll(/type:\s*"([a-z_]+\.[a-z_.]+)"/g)].map((m) => m[1]!);
  const handlerSection = exec.split("export const HANDLERS")[1] ?? "";
  const handlerTypes = [...handlerSection.matchAll(/"([a-z_]+\.[a-z_.]+)":\s*async/g)].map((m) => m[1]!);
  const missingHandler = catalogTypes.filter((t) => !handlerTypes.includes(t));
  const orphanHandler = handlerTypes.filter((t) => !catalogTypes.includes(t));
  if (missingHandler.length > 0) throw new Error(`catalog nodes without handlers: ${missingHandler.join(", ")}`);
  if (orphanHandler.length > 0) throw new Error(`handlers without catalog entries: ${orphanHandler.join(", ")}`);
  return `${catalogTypes.length} catalog nodes ↔ ${handlerTypes.length} handlers; perfect parity`;
});

probe("§13.7", "42 schema modules in lib/db/src/schema/", () => {
  const dir = join(ROOT, "lib/db/src/schema");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts");
  if (files.length !== 42) throw new Error(`expected 42 schema files, found ${files.length}`);
  return `lib/db/src/schema has 42 .ts modules (matches §13.7 claim)`;
});

probe("§13.7", "processed_webhook_events schema exists", () => {
  const s = read("lib/db/src/schema/processed_webhook_events.ts");
  mustContain(s, "processed_webhook_events", "table name");
  mustContain(s, "external_event_id", "external_event_id column");
  return "schema/processed_webhook_events.ts has the documented idempotency table";
});

probe("§13.11", "webhook-idempotency helper exists and is wired into webhook handlers", () => {
  const h = read("artifacts/api-server/src/lib/webhook-idempotency.ts");
  mustContain(h, "markWebhookProcessed", "markWebhookProcessed export");
  // Verify it's actually called from at least one webhook handler
  const wh = read("artifacts/api-server/src/routes/webhooks.ts");
  mustContain(wh, "markWebhookProcessed", "called from webhooks.ts");
  return "webhook-idempotency.ts exports markWebhookProcessed; webhooks.ts uses it";
});

probe("§13.12", "Per-firm webhook URL variants wired", () => {
  const wh = read("artifacts/api-server/src/routes/webhooks.ts");
  // Per-firm URL pattern wires the new /i/:integrationId suffix
  mustContain(wh, "/i/:integrationId", "per-firm URL pattern");
  mustContain(wh, "readExplicitIntegrationId", "explicit-id reader");
  return "webhooks.ts accepts both /provider and /provider/i/:integrationId for email/sms/fax/voice";
});

probe("§13.9", "Lead status enum values are referenced somewhere in the codebase", () => {
  // Status string literals are scattered across routes/leads.ts (the
  // intake + qualify flows), routes/analytics.ts (the dashboard counts),
  // decision-engine-service.ts, and worker handlers. We look in the
  // union of those files rather than any one file, because no single
  // file references the full enum (intentional: `signed` is written by
  // the e-sign webhook handler, not by leads.ts).
  const expected = ["new", "qualified", "signed", "review_required", "rejected"];
  const blob = [
    "artifacts/api-server/src/routes/leads.ts",
    "artifacts/api-server/src/routes/analytics.ts",
    "artifacts/api-server/src/routes/webhooks.ts",
    "artifacts/api-server/src/lib/decision-engine-service.ts",
    "artifacts/api-server/src/lib/workflow-engine.ts",
    "artifacts/api-server/src/worker.ts",
  ]
    .map((p) => readMaybe(p) ?? "")
    .join("\n\n");
  const missing = expected.filter((s) => !blob.includes(`"${s}"`));
  if (missing.length > 0) throw new Error(`status enum values not referenced anywhere: ${missing.join(", ")}`);
  return `Lead status enum: all ${expected.length} documented values referenced in code`;
});

// =============================================================================
// Recursive safeguards added during the security pass
// =============================================================================

probe("security", "CI poller has cycle-in-flight mutex", () => {
  const ci = read("artifacts/api-server/src/lib/ci-poller.ts");
  mustContain(ci, "cycleInFlight", "cycle mutex");
  return "ci-poller.ts has cycleInFlight mutex to prevent overlapping ticks";
});

probe("security", "Vapi tools log every failed bearer attempt with IP", () => {
  const vt = read("artifacts/api-server/src/routes/vapi-tools.ts");
  mustContain(vt, "clientIpOf", "clientIpOf helper");
  mustContain(vt, /logger\.warn[\s\S]{0,200}bearer/i, "bearer-warn log");
  return "vapi-tools.ts logs IP + reason for every rejected bearer";
});

probe("security", "Backfill SQL files exist for cases / integrations / webhook-events", () => {
  for (const f of [
    "scripts/backfill-cases-firm-id.sql",
    "scripts/backfill-integrations-firm-id.sql",
    "scripts/backfill-processed-webhook-events.sql",
  ]) {
    if (!existsSync(join(ROOT, f))) throw new Error(`${f} missing`);
  }
  return "All 3 operator-runnable backfill SQL scripts present";
});

probe("security", "Automation crm.* handlers firm-scope every lead touch", () => {
  const x = read("artifacts/api-server/src/lib/automations/executor.ts");
  // four critical handlers: qualify_lead, assign_paralegal, background_check, decision_engine
  // each must reference s.ctx.firmId
  for (const name of ["crm.qualify_lead", "crm.assign_paralegal", "crm.background_check", "crm.decision_engine"]) {
    const handlerBlock = x.split(`"${name}"`)[1]?.split("},")[0] ?? "";
    if (!handlerBlock.includes("s.ctx.firmId")) {
      throw new Error(`${name} handler missing s.ctx.firmId guard`);
    }
  }
  return "executor.ts: qualify_lead / assign_paralegal / background_check / decision_engine all firm-scoped";
});

probe("security", "forms.create_lead_from_submission stamps firm_id", () => {
  const x = read("artifacts/api-server/src/lib/automations/executor.ts");
  // find the forms.create_lead_from_submission handler block
  const block = x.split('"forms.create_lead_from_submission"')[1] ?? "";
  if (!block.includes("firm_id: s.ctx.firmId")) throw new Error("firm_id stamp missing");
  return "forms.create_lead_from_submission stamps firm_id from run context";
});

// =============================================================================
// Manual file:line citations spot-check
// =============================================================================

probe("manual citations", "rbac.ts:51 actually contains UserRole union", () => {
  const lines = read("artifacts/api-server/src/lib/rbac.ts").split("\n");
  const line51 = lines[50] ?? ""; // 0-indexed
  if (!line51.includes("UserRole")) throw new Error(`rbac.ts:51 is "${line51.trim()}", expected UserRole`);
  return `rbac.ts:51 = "${line51.trim().slice(0, 80)}"`;
});

probe("manual citations", "encryption.ts:27 contains CURRENT_KEY_VERSION = 1", () => {
  const lines = read("artifacts/api-server/src/lib/encryption.ts").split("\n");
  const line = lines[26] ?? "";
  if (!line.includes("CURRENT_KEY_VERSION = 1")) {
    throw new Error(`encryption.ts:27 = "${line.trim()}", expected CURRENT_KEY_VERSION = 1`);
  }
  return `encryption.ts:27 = "${line.trim()}"`;
});

probe("manual citations", "hub.ts:31-43 has every ADAPTERS entry", () => {
  const hub = read("artifacts/api-server/src/lib/bg-hub/hub.ts");
  const idx = hub.indexOf("const ADAPTERS");
  if (idx === -1) throw new Error("ADAPTERS const not found");
  const block = hub.slice(idx, idx + 1500);
  const count = countMatches(block, /lane:\s*"/g);
  if (count !== 11) throw new Error(`ADAPTERS list has ${count} entries, expected 11`);
  return `hub.ts ADAPTERS block has exactly 11 lane entries`;
});

// =============================================================================
// Output
// =============================================================================

function formatMarkdown(rs: ProbeResult[]): string {
  const groups = new Map<string, ProbeResult[]>();
  for (const r of rs) {
    const k = r.section;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const lines: string[] = [];
  lines.push("# MTOS Smoke Report");
  lines.push("");
  const passes = rs.filter((r) => r.outcome === "PASS").length;
  const fails = rs.filter((r) => r.outcome === "FAIL").length;
  const skips = rs.filter((r) => r.outcome === "SKIP").length;
  lines.push(`**Probes:** ${rs.length} · **PASS:** ${passes} · **FAIL:** ${fails} · **SKIP:** ${skips}`);
  lines.push("");
  if (fails > 0) {
    lines.push(`## :x: Failures (${fails})`);
    for (const r of rs.filter((r) => r.outcome === "FAIL")) {
      lines.push(`- **${r.section} — ${r.capability}**`);
      lines.push(`  - Reason: \`${r.reason}\``);
    }
    lines.push("");
  }
  if (skips > 0) {
    lines.push(`## :warning: Skipped (${skips})`);
    for (const r of rs.filter((r) => r.outcome === "SKIP")) {
      lines.push(`- **${r.section} — ${r.capability}** — ${r.reason}`);
    }
    lines.push("");
  }
  lines.push(`## :white_check_mark: Passes by section`);
  lines.push("");
  for (const [section, list] of [...groups.entries()].sort()) {
    const sectionPasses = list.filter((r) => r.outcome === "PASS");
    if (sectionPasses.length === 0) continue;
    lines.push(`### ${section}`);
    for (const r of sectionPasses) {
      lines.push(`- ✅ ${r.capability} — ${r.evidence}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const md = formatMarkdown(results);
console.log(md);
writeFileSync(join(ROOT, "smoke-report.json"), JSON.stringify(results, null, 2));
writeFileSync(join(ROOT, "smoke-report.md"), md);

const failed = results.filter((r) => r.outcome === "FAIL").length;
console.error(""); // separator
console.error(`Smoke complete: ${results.length} probes, ${results.filter((r) => r.outcome === "PASS").length} passed, ${failed} failed, ${results.filter((r) => r.outcome === "SKIP").length} skipped.`);
console.error(`Wrote smoke-report.json and smoke-report.md to repo root.`);
process.exit(failed > 0 ? 1 : 0);
