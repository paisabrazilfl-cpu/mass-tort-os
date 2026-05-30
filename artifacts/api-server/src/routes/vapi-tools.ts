/**
 * Vapi tool callbacks — public (bearer-gated) endpoints the Vapi
 * assistant calls during a live conversation.
 *
 * These are NOT session-authenticated. Vapi sends a static bearer
 * token configured in the assistant; we compare it (constant-time)
 * against `client_secret` on the active vapi integration row.
 *
 * The router is mounted under /api/vapi-tools (top-level under /api so
 * the dump-route-matrix validator sees it without a session middleware
 * chain) and marked `markPublic` so the route-protection validator does
 * not require authMiddleware. Each handler verifies the bearer at
 * request time and returns 401 on mismatch. Configure your Vapi
 * assistant tool URLs as `${PUBLIC_API_BASE}/api/vapi-tools/<tool>`.
 *
 * Tools exposed:
 *   POST /lookup-lead         -> { found, lead_id, name, status }
 *   POST /create-lead         -> { lead_id }
 *   POST /check-eligibility   -> { result: "go"|"hold"|"abort", reason, disqualifiers[] }
 *   POST /escalate-to-human   -> { ok } (also writes a review_queue row)
 *
 * PII handling: create-lead inserts encrypted ciphertexts via
 * encryptLeadFields() then rebinds AAD to the assigned lead.id (#8) so
 * the row matches the encryption shape used by every other ingestion
 * surface (CSV, intake form, public-leads).
 *
 * Each tool accepts a JSON body keyed by snake_case fields per the
 * Vapi assistant configuration. Failures return 200 with `ok:false`
 * so the assistant can recover gracefully (Vapi treats 5xx as the
 * tool unavailable and aborts the call).
 */
import { Router, type Request } from "express";
import crypto from "crypto";
import { z } from "zod/v4";
import { db, leadsTable, leadDispositionsTable, reviewQueueTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { loadVapiCredentials } from "../lib/voice/vapi-webhook";
import { computeAndPersistLeadScore } from "../lib/decision-engine-service";
import { encryptLeadFields, decryptLeadFields, rebindLeadEncryptionAad } from "../lib/encryption";
import { leadLookupHash } from "../lib/lead-lookup-hash";
import { findExistingLeadForIntake } from "../lib/lead-dedup";

const router = Router();

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

async function checkBearer(req: Request): Promise<boolean> {
  const auth = req.headers.authorization;
  if (typeof auth !== "string" || !auth.toLowerCase().startsWith("bearer ")) {
    return false;
  }
  const provided = auth.slice(7).trim();
  if (!provided) return false;
  const creds = await loadVapiCredentials();
  if (!creds?.toolBearer) return false;
  return constantTimeEqual(provided, creds.toolBearer);
}

type TortScope =
  | { ok: true; tort: string }
  | { ok: false; code: "BAD_TORT_SCOPE" };

/**
 * Resolve (and enforce) the tort for a tool call. Per-tort agents (Task #90)
 * bake a `?tort=<id>` hint into each tool's server URL. That URL is owned by
 * the provisioner, not the caller, so it is AUTHORITATIVE — the model cannot
 * widen its own scope by sending a different tort_type in the body. If the
 * body disagrees with the URL hint we reject (BAD_TORT_SCOPE) rather than
 * silently trusting model-supplied args, which preserves the "one dedicated
 * agent per tort" isolation guarantee.
 *
 * When no URL hint is present (e.g. the legacy generic assistant), we fall
 * back to the body value, then to "unknown".
 */
export function resolveTortType(req: Request, bodyTort: string | null | undefined): TortScope {
  const rawBody = typeof bodyTort === "string" ? bodyTort.trim() : "";
  // "unknown" is the schema-level placeholder the model emits when it has no
  // real tort to report; treat it as absent so a query-scoped agent is never
  // rejected just because the model omitted (and the schema defaulted) the
  // body tort. Only a *real, different* body tort counts as a scope conflict.
  const fromBody = rawBody.toLowerCase() === "unknown" ? "" : rawBody;
  const q = req.query?.tort;
  const fromQuery = typeof q === "string" ? q.trim() : "";
  if (fromQuery) {
    if (fromBody && fromBody !== fromQuery) {
      return { ok: false, code: "BAD_TORT_SCOPE" };
    }
    return { ok: true, tort: fromQuery };
  }
  if (fromBody) return { ok: true, tort: fromBody };
  return { ok: true, tort: "unknown" };
}

/**
 * Conflict-resolution guard for callbacks that operate on an existing lead
 * (check-eligibility, escalate-to-human). A per-tort agent bakes `?tort=<id>`
 * into its tool URLs, so a request that targets a lead belonging to a
 * DIFFERENT tort is a cross-tort scope violation (model hallucinated a
 * lead_id, or a misconfigured assistant). We fail closed rather than acting
 * on another tort's lead.
 *
 * Returns:
 *   - { ok: true }                  lead matches the scoped tort (or no scope)
 *   - { ok: false, code: ... }      mismatch / lead missing
 */
async function assertLeadInScope(
  leadId: number,
  scopeTort: string,
): Promise<{ ok: true } | { ok: false; code: "CROSS_TORT" | "LEAD_NOT_FOUND" }> {
  // No real scope to enforce (legacy generic assistant or unscoped call).
  if (!scopeTort || scopeTort === "unknown") return { ok: true };
  const rows = await db
    .select({ tort_type: leadsTable.tort_type })
    .from(leadsTable)
    .where(eq(leadsTable.id, leadId))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, code: "LEAD_NOT_FOUND" };
  if (row.tort_type !== scopeTort) return { ok: false, code: "CROSS_TORT" };
  return { ok: true };
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return "";
}

// NOTE: We intentionally use the canonical `leadLookupHash(tort, email, phone)`
// from lib/lead-lookup-hash.ts (and the `findExistingLeadForIntake` dedup
// pipeline from lib/lead-dedup.ts) so Vapi-created leads share the SAME
// dedup contract as CSV / intake-form / public-leads. A previous version
// of this file hashed (phone|dob), which would have silently created
// duplicate rows for leads visible to the rest of the pipeline because
// `leads.lookup_hash` was being written with two different semantics.

const lookupSchema = z.object({
  phone: z.string().min(7).max(32),
  email: z.string().email().optional().nullable(),
  tort_type: z.string().min(1).max(100).optional().nullable(),
  // Accepted for back-compat with the assistant config; not used in the
  // canonical hash (the (tort|email|phone10) triple is the contract).
  date_of_birth: z.string().optional().nullable(),
});

router.post("/lookup-lead", async (req, res) => {
  if (!(await checkBearer(req))) {
    res.status(401).json({ ok: false, code: "UNAUTHORIZED" });
    return;
  }
  const parsed = lookupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(200).json({ ok: false, code: "BAD_REQUEST", issues: parsed.error.issues });
    return;
  }
  const phoneE164 = normalizePhone(parsed.data.phone);
  if (!phoneE164) {
    res.status(200).json({ ok: false, code: "BAD_PHONE" });
    return;
  }
  const scope = resolveTortType(req, parsed.data.tort_type);
  if (!scope.ok) {
    res.status(200).json({ ok: false, code: scope.code });
    return;
  }
  const tortType = scope.tort;
  try {
    // Use the shared dedup pipeline. It tries (tort|email|phone10) hash
    // first, then exact email, then a phone-decrypt scan — exactly what
    // every other ingestion surface uses, so Vapi sees the same matches
    // a CSV import would.
    const match = await findExistingLeadForIntake({
      tortType,
      email: parsed.data.email ?? null,
      phone: phoneE164,
    });
    if (!match) {
      res.status(200).json({ ok: true, found: false });
      return;
    }
    const rows = await db
      .select({
        id: leadsTable.id,
        first_name: leadsTable.first_name,
        last_name: leadsTable.last_name,
        status: leadsTable.status,
      })
      .from(leadsTable)
      .where(eq(leadsTable.id, match.leadId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(200).json({ ok: true, found: false });
      return;
    }
    res.status(200).json({
      ok: true,
      found: true,
      lead_id: row.id,
      name: [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
      status: row.status,
    });
  } catch (err) {
    logger.error({ err }, "vapi-tools lookup-lead failed");
    res.status(200).json({ ok: false, code: "INTERNAL" });
  }
});

const createLeadSchema = z.object({
  phone: z.string().min(7).max(32),
  first_name: z.string().min(1).max(120).optional().nullable(),
  last_name: z.string().min(1).max(120).optional().nullable(),
  date_of_birth: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  tort_type: z.string().min(1).max(100).default("unknown"),
  source: z.string().min(1).max(60).default("vapi"),
  notes: z.string().max(2000).optional().nullable(),
});

router.post("/create-lead", async (req, res) => {
  if (!(await checkBearer(req))) {
    res.status(401).json({ ok: false, code: "UNAUTHORIZED" });
    return;
  }
  const parsed = createLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(200).json({ ok: false, code: "BAD_REQUEST", issues: parsed.error.issues });
    return;
  }
  const phoneE164 = normalizePhone(parsed.data.phone);
  if (!phoneE164) {
    res.status(200).json({ ok: false, code: "BAD_PHONE" });
    return;
  }
  const dob = parsed.data.date_of_birth ?? null;
  const scope = resolveTortType(req, parsed.data.tort_type);
  if (!scope.ok) {
    res.status(200).json({ ok: false, code: scope.code });
    return;
  }
  const tortType = scope.tort;
  // Canonical hash (matches CSV / form / public-leads). May be null when
  // email is missing — that is correct: lookup_hash is intentionally NOT
  // populated for partial inputs to avoid (tort, email, "")(tort, email, phone)
  // collisions silently deduping unrelated rows.
  const hash = leadLookupHash(tortType, parsed.data.email ?? null, phoneE164);
  try {
    // Dedupe through the shared pipeline so we hit the same matches every
    // other ingestion surface would.
    const existing = await findExistingLeadForIntake({
      tortType,
      email: parsed.data.email ?? null,
      phone: phoneE164,
    });
    if (existing) {
      res.status(200).json({ ok: true, lead_id: existing.leadId, deduped: true });
      return;
    }

    const fullName =
      [parsed.data.first_name, parsed.data.last_name].filter(Boolean).join(" ").trim() ||
      `Vapi caller ${phoneE164}`;
    // Task #8: encrypt PII before insert. We can't pass entityId yet
    // (id is serial, assigned by RETURNING), so we encrypt with a
    // (fieldName)-only AAD and immediately rebind to (fieldName, id)
    // post-insert via rebindLeadEncryptionAad. lookup_hash is computed
    // from the PLAINTEXT phone so dedupe queries continue to work.
    const encryptedFields = encryptLeadFields({
      name: fullName,
      first_name: parsed.data.first_name ?? null,
      last_name: parsed.data.last_name ?? null,
      phone: phoneE164,
      email: parsed.data.email ?? null,
      date_of_birth: dob,
      notes: parsed.data.notes ?? null,
    });
    // encryptLeadFields returns Record<string,any> (it has to — it strips PII
    // by name, not by table shape). We cast it to the table's PII subtype so
    // the spread satisfies the leads insert schema without the `as any` cast
    // that previous reviewers flagged as type-safety slop. The cast is
    // narrow and named, not a blanket `as any`.
    type LeadPiiInsert = Pick<
      typeof leadsTable.$inferInsert,
      "name" | "first_name" | "last_name" | "phone" | "email" | "date_of_birth" | "notes"
    >;
    const insertRow: typeof leadsTable.$inferInsert = {
      tort_type: tortType,
      source: parsed.data.source,
      status: "new",
      lookup_hash: hash,
      ...(encryptedFields as LeadPiiInsert),
    };
    const [inserted] = await db.insert(leadsTable).values(insertRow).returning();
    // Task #8: rebind ciphertext AAD to the freshly-assigned lead.id.
    await rebindLeadEncryptionAad(db, leadsTable, inserted!, eq);

    res.status(200).json({ ok: true, lead_id: inserted!.id, deduped: false });
  } catch (err) {
    logger.error({ err }, "vapi-tools create-lead failed");
    res.status(200).json({ ok: false, code: "INTERNAL" });
  }
});

const eligibilitySchema = z.object({
  lead_id: z.coerce.number().int().positive(),
  tort_type: z.string().min(1).max(100).optional().nullable(),
});

/**
 * Map a decision-engine ScoreResult into the Vapi assistant's
 * three-way verdict contract.
 *
 * The engine's Action enum (lib/decision-engine.ts) is:
 *   "execute" | "modify" | "reject" | "review"
 *
 * Collapsed for the assistant:
 *   execute            → "go"     (eligible, proceed with intake)
 *   modify | review    → "hold"   (route to human; do not abort)
 *   reject             → "abort"  (politely end the call)
 *   unknown / missing  → "abort"  (fail closed)
 *
 * Exported so the mapping is unit-tested directly — drift between this
 * mapping and the engine's enum has caused live aborts before.
 */
export function mapEligibilityResult(result: {
  action?: string | null;
  rationale?: string | null;
  ruin_flags?: string[] | null;
  missing_fields?: string[] | null;
  contradictions?: string[] | null;
}): { result: "go" | "hold" | "abort"; reason: string; disqualifiers: string[] } {
  const action = String(result.action ?? "").toLowerCase();
  let verdict: "go" | "hold" | "abort";
  if (action === "execute") verdict = "go";
  else if (action === "modify" || action === "review") verdict = "hold";
  else if (action === "reject") verdict = "abort";
  else verdict = "abort";

  const disqualifiers = [
    ...(result.ruin_flags ?? []),
    ...(result.missing_fields ?? []).map((f) => `missing:${f}`),
    ...(result.contradictions ?? []),
  ];
  const rationale =
    typeof result.rationale === "string" ? result.rationale.trim() : "";
  const reason =
    rationale ||
    disqualifiers[0] ||
    `decision:${(result.action ?? "unknown").toLowerCase()}`;

  return { result: verdict, reason, disqualifiers };
}

router.post("/check-eligibility", async (req, res) => {
  if (!(await checkBearer(req))) {
    res.status(401).json({ ok: false, code: "UNAUTHORIZED" });
    return;
  }
  const parsed = eligibilitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(200).json({ ok: false, code: "BAD_REQUEST", issues: parsed.error.issues });
    return;
  }
  const scope = resolveTortType(req, parsed.data.tort_type);
  if (!scope.ok) {
    res.status(200).json({ ok: false, code: scope.code });
    return;
  }
  try {
    const inScope = await assertLeadInScope(parsed.data.lead_id, scope.tort);
    if (!inScope.ok) {
      // Fail closed: never score a lead outside this agent's tort.
      res.status(200).json({
        ok: true,
        result: "abort",
        reason: inScope.code === "CROSS_TORT" ? "cross_tort_scope" : "lead_not_found",
        disqualifiers: [inScope.code === "CROSS_TORT" ? "cross_tort_scope" : "lead_not_found"],
      });
      return;
    }
    const result = await computeAndPersistLeadScore(parsed.data.lead_id);
    if (!result) {
      res.status(200).json({
        ok: true,
        result: "abort",
        reason: "lead_not_found",
        disqualifiers: ["lead_not_found"],
      });
      return;
    }
    const { result: verdict, reason, disqualifiers } = mapEligibilityResult(result);
    res.status(200).json({
      ok: true,
      result: verdict,
      reason,
      disqualifiers,
    });
  } catch (err) {
    logger.error({ err, lead_id: parsed.data.lead_id }, "vapi-tools check-eligibility failed");
    res.status(200).json({ ok: false, code: "INTERNAL" });
  }
});

const escalateSchema = z.object({
  lead_id: z.coerce.number().int().positive().optional().nullable(),
  call_id: z.string().min(1).max(100).optional().nullable(),
  reason: z.string().max(500).default("vapi_escalation"),
  tort_type: z.string().min(1).max(100).optional().nullable(),
});

router.post("/escalate-to-human", async (req, res) => {
  if (!(await checkBearer(req))) {
    res.status(401).json({ ok: false, code: "UNAUTHORIZED" });
    return;
  }
  const parsed = escalateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(200).json({ ok: false, code: "BAD_REQUEST", issues: parsed.error.issues });
    return;
  }
  const scope = resolveTortType(req, parsed.data.tort_type);
  if (!scope.ok) {
    res.status(200).json({ ok: false, code: scope.code });
    return;
  }
  try {
    if (parsed.data.lead_id) {
      const inScope = await assertLeadInScope(parsed.data.lead_id, scope.tort);
      if (!inScope.ok) {
        res.status(200).json({ ok: false, code: inScope.code });
        return;
      }
      // Pull firm_id off the lead so disposition row joins correctly.
      const lead = await db
        .select({ id: leadsTable.id, firm_id: leadsTable.firm_id })
        .from(leadsTable)
        .where(eq(leadsTable.id, parsed.data.lead_id))
        .limit(1);
      if (!lead[0]) {
        res.status(200).json({ ok: false, code: "LEAD_NOT_FOUND" });
        return;
      }
      await db.insert(leadDispositionsTable).values({
        firm_id: lead[0].firm_id,
        lead_id: parsed.data.lead_id,
        disposition: "human_review",
        reason: parsed.data.reason,
        source: "vapi",
      });
      // Bump the lead.status so review-queue picks it up.
      await db
        .update(leadsTable)
        .set({ status: "review", updated_at: sql`now()` })
        .where(eq(leadsTable.id, parsed.data.lead_id));
      // Spec: also post to review_queue so operators see a single
      // queue entry (not just the disposition row + the lead.status
      // bump). source_module="vapi" lets the UI filter/badge it.
      // failsafe_mode="REVIEW_FAIL" matches the existing taxonomy
      // used by conflict-engine + worker for human-review escalations.
      await db.insert(reviewQueueTable).values({
        entity_type: "lead",
        entity_id: String(parsed.data.lead_id),
        conflict_type: "vapi_escalation",
        severity: "medium",
        failsafe_mode: "REVIEW_FAIL",
        source_module: "vapi",
        summary: parsed.data.reason || "Vapi assistant escalated to human review",
        details: {
          vapi_call_id: parsed.data.call_id ?? null,
          firm_id: lead[0].firm_id,
        },
      });
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "vapi-tools escalate-to-human failed");
    res.status(200).json({ ok: false, code: "INTERNAL" });
  }
});

// ─── update-lead (progressive save) ──────────────────────────────────────────
// Called repeatedly DURING a live call so each confirmed answer is persisted
// as it is captured — if the caller hangs up mid-intake, everything gathered
// so far is already on the lead instead of being lost at end-of-call.
//
// Partial by design: only fields the agent actually sends are written
// (overwriting the existing value with the freshly-confirmed one). PII is
// encrypted with AAD bound to (fieldName, lead.id) — the correct shape for an
// UPDATE on a known id, matching the leads route. Tort scope is enforced the
// same way as check-eligibility/escalate so an agent can never edit a lead
// outside its own tort.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const updateLeadSchema = z.object({
  lead_id: z.coerce.number().int().positive(),
  tort_type: z.string().min(1).max(100).optional().nullable(),
  first_name: z.string().min(1).max(120).optional().nullable(),
  last_name: z.string().min(1).max(120).optional().nullable(),
  date_of_birth: z.string().max(40).optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().min(7).max(32).optional().nullable(),
  street_address: z.string().max(300).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(2).optional().nullable(),
  zip: z.string().max(10).optional().nullable(),
  diagnosis: z.string().max(500).optional().nullable(),
  diagnosis_type: z.string().max(255).optional().nullable(),
  diagnosis_date: z.string().max(40).optional().nullable(),
  exposure_start: z.string().max(40).optional().nullable(),
  exposure_end: z.string().max(40).optional().nullable(),
  location_name: z.string().max(255).optional().nullable(),
  medications: z.string().max(1000).optional().nullable(),
  physician_first_name: z.string().max(255).optional().nullable(),
  physician_last_name: z.string().max(255).optional().nullable(),
  physician_full_address: z.string().max(500).optional().nullable(),
  physician_contact_info: z.string().max(500).optional().nullable(),
  hospital_name: z.string().max(500).optional().nullable(),
  hospital_contact_info: z.string().max(500).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
});

router.post("/update-lead", async (req, res) => {
  if (!(await checkBearer(req))) {
    res.status(401).json({ ok: false, code: "UNAUTHORIZED" });
    return;
  }
  const parsed = updateLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(200).json({ ok: false, code: "BAD_REQUEST", issues: parsed.error.issues });
    return;
  }
  const scope = resolveTortType(req, parsed.data.tort_type);
  if (!scope.ok) {
    res.status(200).json({ ok: false, code: scope.code });
    return;
  }
  const leadId = parsed.data.lead_id;
  try {
    const inScope = await assertLeadInScope(leadId, scope.tort);
    if (!inScope.ok) {
      res.status(200).json({ ok: false, code: inScope.code });
      return;
    }

    const existingRows = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId))
      .limit(1);
    const existingRow = existingRows[0];
    if (!existingRow) {
      res.status(200).json({ ok: false, code: "LEAD_NOT_FOUND" });
      return;
    }
    const existing = decryptLeadFields(existingRow as Record<string, unknown>, String(leadId));

    // Collect provided plaintext fields. `undefined` (key absent) means
    // "leave alone"; an explicit value (incl. provided string) overwrites.
    const d = parsed.data;
    const plain: Record<string, unknown> = {};
    const setIf = (key: string, val: string | null | undefined) => {
      if (val === undefined || val === null) return;
      const t = val.trim();
      if (t.length > 0) plain[key] = t;
    };

    setIf("first_name", d.first_name);
    setIf("last_name", d.last_name);
    setIf("date_of_birth", d.date_of_birth);
    setIf("email", d.email);
    setIf("street_address", d.street_address);
    setIf("city", d.city);
    setIf("state", d.state ? d.state.toUpperCase() : d.state);
    setIf("zip", d.zip);
    setIf("diagnosis", d.diagnosis);
    setIf("diagnosis_type", d.diagnosis_type);
    setIf("diagnosis_date", d.diagnosis_date);
    setIf("location_name", d.location_name);
    setIf("medications", d.medications);
    setIf("physician_first_name", d.physician_first_name);
    setIf("physician_last_name", d.physician_last_name);
    setIf("physician_full_address", d.physician_full_address);
    setIf("physician_contact_info", d.physician_contact_info);
    setIf("hospital_name", d.hospital_name);
    setIf("hospital_contact_info", d.hospital_contact_info);
    setIf("notes", d.notes);

    // Phone normalized to E.164 like every other intake surface.
    if (d.phone != null) {
      const phoneE164 = normalizePhone(d.phone);
      if (phoneE164) plain.phone = phoneE164;
    }

    // Exposure columns are real DATE columns — only accept YYYY-MM-DD so a
    // loose spoken date never throws and aborts the whole save.
    if (d.exposure_start != null && DATE_ONLY.test(d.exposure_start.trim())) {
      plain.exposure_start = d.exposure_start.trim();
    }
    if (d.exposure_end != null && DATE_ONLY.test(d.exposure_end.trim())) {
      plain.exposure_end = d.exposure_end.trim();
    }

    // Keep the display `name` coherent when either name part changes.
    if (plain.first_name !== undefined || plain.last_name !== undefined) {
      const first = (plain.first_name ?? existing.first_name ?? "") as string;
      const last = (plain.last_name ?? existing.last_name ?? "") as string;
      const composed = [first, last].filter((s) => String(s).trim().length > 0).join(" ").trim();
      if (composed) plain.name = composed;
    }

    if (Object.keys(plain).length === 0) {
      res.status(200).json({ ok: true, updated: [] });
      return;
    }

    // Recompute the canonical lookup_hash from the merged plaintext triple so
    // dedup stays consistent once both email and phone are known.
    const mergedEmail = (plain.email ?? existing.email ?? null) as string | null;
    const mergedPhone = (plain.phone ?? existing.phone ?? null) as string | null;
    const hash = leadLookupHash(scope.tort === "unknown" ? existingRow.tort_type : scope.tort, mergedEmail, mergedPhone);

    const encrypted = encryptLeadFields(plain, String(leadId));
    const updateRow: Record<string, unknown> = { ...encrypted, updated_at: new Date() };
    if (hash) updateRow.lookup_hash = hash;

    await db.update(leadsTable).set(updateRow).where(eq(leadsTable.id, leadId));

    res.status(200).json({ ok: true, updated: Object.keys(plain) });
  } catch (err) {
    logger.error({ err, lead_id: leadId }, "vapi-tools update-lead failed");
    res.status(200).json({ ok: false, code: "INTERNAL" });
  }
});

export default router;
