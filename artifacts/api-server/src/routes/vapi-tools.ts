/**
 * Vapi tool callbacks — public (bearer-gated) endpoints the Vapi
 * assistant calls during a live conversation.
 *
 * These are NOT session-authenticated. Vapi sends a static bearer
 * token configured in the assistant; we compare it (constant-time)
 * against `client_secret` on the active vapi integration row.
 *
 * The router is mounted under /api/webhooks/vapi-tools and marked
 * `markPublic` so the route-protection validator does not require
 * authMiddleware. Each handler verifies the bearer at request time
 * and returns 401 on mismatch.
 *
 * Tools exposed:
 *   POST /lookup-lead         -> { found, lead_id, name, status }
 *   POST /create-lead         -> { lead_id }
 *   POST /check-eligibility   -> { eligible, reasons[], score }
 *   POST /escalate-to-human   -> { ok }
 *
 * Each tool accepts a JSON body keyed by snake_case fields per the
 * Vapi assistant configuration. Failures return 200 with `ok:false`
 * so the assistant can recover gracefully (Vapi treats 5xx as the
 * tool unavailable and aborts the call).
 */
import { Router, type Request } from "express";
import crypto from "crypto";
import { z } from "zod/v4";
import { db, leadsTable, leadDispositionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { loadVapiCredentials } from "../lib/voice/vapi";
import { computeAndPersistLeadScore } from "../lib/decision-engine-service";

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

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return "";
}

function lookupHash(phoneE164: string, dob: string | null): string {
  const norm = `${phoneE164}|${dob ?? ""}`.toLowerCase();
  return crypto.createHash("sha256").update(norm).digest("hex");
}

const lookupSchema = z.object({
  phone: z.string().min(7).max(32),
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
  const dob = parsed.data.date_of_birth ?? null;
  const hash = lookupHash(phoneE164, dob);
  try {
    const rows = await db
      .select({
        id: leadsTable.id,
        first_name: leadsTable.first_name,
        last_name: leadsTable.last_name,
        status: leadsTable.status,
      })
      .from(leadsTable)
      .where(eq(leadsTable.lookup_hash, hash))
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
  const hash = lookupHash(phoneE164, dob);
  try {
    // Dedupe — return the existing row if we already have one.
    const existing = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(eq(leadsTable.lookup_hash, hash))
      .limit(1);
    if (existing[0]) {
      res.status(200).json({ ok: true, lead_id: existing[0].id, deduped: true });
      return;
    }

    const fullName =
      [parsed.data.first_name, parsed.data.last_name].filter(Boolean).join(" ").trim() ||
      `Vapi caller ${phoneE164}`;
    const [inserted] = await db
      .insert(leadsTable)
      .values({
        name: fullName,
        first_name: parsed.data.first_name ?? null,
        last_name: parsed.data.last_name ?? null,
        phone: phoneE164,
        email: parsed.data.email ?? null,
        date_of_birth: dob,
        tort_type: parsed.data.tort_type,
        source: parsed.data.source,
        status: "new",
        notes: parsed.data.notes ?? null,
        lookup_hash: hash,
      })
      .returning({ id: leadsTable.id });

    res.status(200).json({ ok: true, lead_id: inserted!.id, deduped: false });
  } catch (err) {
    logger.error({ err }, "vapi-tools create-lead failed");
    res.status(200).json({ ok: false, code: "INTERNAL" });
  }
});

const eligibilitySchema = z.object({
  lead_id: z.coerce.number().int().positive(),
});

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
  try {
    const result = await computeAndPersistLeadScore(parsed.data.lead_id);
    if (!result) {
      res.status(200).json({ ok: true, eligible: false, reasons: ["lead_not_found"] });
      return;
    }
    // Map the decision-engine action → eligibility verdict.
    //   ACCEPT       → eligible
    //   REVIEW/DEFER → human review (not auto-eligible, but not abort)
    //   ABORT        → ineligible
    // The assistant uses `eligible` for its primary branch and the full
    // breakdown for its narration.
    const action = String(result.action ?? "").toUpperCase();
    const eligible = action === "ACCEPT";
    res.status(200).json({
      ok: true,
      eligible,
      action: result.action,
      classification: result.classification,
      ratio: result.ratio,
      reasons: [
        ...(result.ruin_flags ?? []),
        ...(result.missing_fields ?? []).map((f) => `missing:${f}`),
        ...(result.contradictions ?? []),
      ],
      rationale: result.rationale,
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
  try {
    if (parsed.data.lead_id) {
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
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "vapi-tools escalate-to-human failed");
    res.status(200).json({ ok: false, code: "INTERNAL" });
  }
});

export default router;
