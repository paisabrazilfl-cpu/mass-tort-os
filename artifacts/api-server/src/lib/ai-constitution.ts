// Loads and serves the MTOS AI Constitution
// (`docs/AI_CONSTITUTION.md`) — the single document every helper LLM in
// this system is bound by. Exposed two ways:
//
//   1. `getAiConstitution()` — returns the full markdown + sha + version
//      for the `/api/admin/ai-constitution` endpoint. Cached on first
//      read; the cache is process-lifetime (a deploy reloads it).
//
//   2. `getAiConstitutionPreamble()` — returns a compact (~600 char)
//      summary that the `/api/automations/assist` endpoint and any
//      future copilot can prepend to its system prompt. The preamble
//      is hand-written here (not auto-extracted) so it stays small and
//      stable even if the full document grows.
//
// Why a separate loader (vs reading the .md inline at every callsite):
//   - Keeps one canonical sha that other surfaces (audit, debugging,
//     "which constitution were you running under?") can quote.
//   - Centralizes the path resolution — same trick `admin-event-catalog`
//     uses for the OpenAPI spec.
//   - Lets us add future preamble variants (e.g. an even shorter one
//     for low-token models) without scattering string literals.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the constitution path robustly across three runtimes:
//   1. tsx tests run from artifacts/api-server → cwd-relative path is wrong
//   2. esbuild bundle in artifacts/api-server/dist/server/index.mjs
//   3. ad-hoc scripts run from the repo root
// Strategy: try candidates in order; first match wins. We anchor to
// `import.meta.url` (the location of THIS source file / bundle) so the
// answer doesn't depend on cwd. The cwd path is the last-ditch fallback
// for any future caller that copies the loader into a non-standard layout.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveConstitutionPath(): string {
  const candidates = [
    // From artifacts/api-server/src/lib/ai-constitution.ts → repo root
    resolve(__dirname, "../../../../docs/AI_CONSTITUTION.md"),
    // From artifacts/api-server/dist/server/index.mjs → repo root
    resolve(__dirname, "../../../docs/AI_CONSTITUTION.md"),
    // cwd fallback (e.g. running from repo root)
    resolve(process.cwd(), "docs/AI_CONSTITUTION.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Throw with the full candidate list so the failure is debuggable
  // instead of returning a "not found" sentinel that callers might miss.
  throw new Error(
    `AI_CONSTITUTION.md not found. Tried:\n  ${candidates.join("\n  ")}`,
  );
}

const CONSTITUTION_PATH = resolveConstitutionPath();

interface ConstitutionPayload {
  version: number;
  sha256: string;
  bytes: number;
  retrieved_at: string;
  markdown: string;
}

let cache: ConstitutionPayload | null = null;

function loadFromDisk(): ConstitutionPayload {
  const markdown = readFileSync(CONSTITUTION_PATH, "utf8");
  // Pull the version line out so it's queryable without parsing markdown.
  // Format: `**Version**: 1` near the top of the document.
  // Fail-closed: if the version header is missing or malformed, throw at
  // load time instead of silently defaulting to 1. The amendment process
  // (§11 of the constitution) requires the version to be bumped on every
  // change; a missing/garbled header almost certainly means the document
  // was edited without following that process, and we want that mistake
  // to surface immediately at server boot rather than ship as "v1" to
  // every helper LLM. Architect review 2026-05-09.
  const versionMatch = markdown.match(/\*\*Version\*\*:\s*(\d+)/);
  if (!versionMatch) {
    throw new Error(
      "AI_CONSTITUTION.md is missing or has a malformed `**Version**: <n>` " +
        "header. The amendment process requires this header to be present " +
        "and bumped on every change.",
    );
  }
  const version = Number(versionMatch[1]);
  const sha256 = createHash("sha256").update(markdown).digest("hex");
  return {
    version,
    sha256,
    bytes: Buffer.byteLength(markdown, "utf8"),
    retrieved_at: new Date().toISOString(),
    markdown,
  };
}

/**
 * Full constitution payload. Cached for the lifetime of the process —
 * the document only changes on deploy.
 */
export function getAiConstitution(): ConstitutionPayload {
  if (cache === null) cache = loadFromDisk();
  // retrieved_at should reflect the *call* time, not the cache time, so
  // operators can tell from the response when they last fetched it.
  return { ...cache, retrieved_at: new Date().toISOString() };
}

/**
 * Compact preamble (~600 chars) for injection into helper-LLM system
 * prompts. Hand-curated from §1, §2, §3, §8 of the constitution. If you
 * change this string, ALSO update the corresponding sections in the
 * markdown so they stay in sync (the constitution is the source of
 * truth; this is the elevator pitch).
 */
export function getAiConstitutionPreamble(): string {
  return [
    "MTOS CONSTITUTION (preamble — full text at GET /api/admin/ai-constitution):",
    "You are inside the Mass Tort Operating System, a CRM for US mass-tort plaintiff law firms (HIPAA-adjacent, TCPA-regulated).",
    "PRIME DIRECTIVE: humans only do FINAL REVIEW. Intake, dedup, scoring, validation, document dispatch, status transitions, and integration glue are yours to solve end-to-end.",
    "HOUSE RULES: (1) deterministic logic first, AI second — only use AI for natural-language work; (2) NEVER invent a clean result — failed/unreachable checks return NOT_RUN, never PASS; (3) audit every state change via lib/audit.ts; (4) respect firm_id tenancy; (5) minimize PII/ePHI in logs; (6) idempotency on all intake.",
    "WHEN STUCK: re-read the constitution, hit discovery endpoints (/api/admin/event-catalog, /api/automations/node-catalog), then either propose an internal automation graph via /api/automations/assist OR file POST /api/review-queue with structured rationale. Forbidden: silently dropping the request or fabricating a result.",
    "BRIGHT LINES — always escalate to review queue: final qualification, disqualification of a REVIEW_REQUIRED lead, e-sign without conflict-check, PACER docket purchase, TCPA/consent changes, medical-record release, case settlement/withdrawal, mass ops on compliance fields.",
  ].join("\n");
}

// Exported for tests so we can assert the cache is populated and that
// the sha is deterministic across reads.
export const __aiConstitutionInternals = { loadFromDisk };
