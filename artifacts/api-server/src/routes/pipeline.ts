/**
 * Intake-to-Med-Recs pipeline control surface (Task #168).
 *
 * These are the deterministic CRM callbacks the n8n orchestrator (or an
 * operator/automation) hits to drive a lead through the pipeline stages that
 * are NOT triggered by an inbound provider webhook:
 *
 *   - intake-completed → runs live NPPES NPI verification (NPI_VERIFIED|NPI_HOLD)
 *   - docs-signed       → manual fallback for the e-sign fan-out
 *   - med-recs-received → manual fallback for inbound-fax correlation
 *   - status            → read the current stage + recent audit trail
 *
 * Auth: every route is permission-gated by automations:execute (the orchestrator
 * authenticates as a service user that carries it). Tenancy is enforced inline —
 * a caller who cannot bypass ownership may only act on leads in their own firm,
 * mirroring leads.ts ensureLeadAccess (which is private to that router).
 */
import { Router } from "express";
import { db, leadsTable, pipelineEventsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { z } from "zod/v4";
import { authMiddleware, Permission, requirePermission, canBypassOwnership } from "../lib/rbac";
import { badRequest, notFound, forbidden } from "../lib/http-errors";
import {
  completeIntake,
  applyDocumentsSigned,
  applyMedRecordsReceived,
} from "../lib/pipeline/pipeline";

const router: ReturnType<typeof Router> = Router();
router.use(authMiddleware);

/**
 * Load the lead and enforce firm tenancy. Returns the lead row, or sends the
 * appropriate error response and returns null (caller must `return` on null).
 */
async function loadLeadScoped(
  req: Parameters<Parameters<typeof router.get>[1]>[0],
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): Promise<{ id: number; firm_id: number | null } | null> {
  const leadId = Number(req.params.id);
  if (!Number.isInteger(leadId) || leadId <= 0) {
    badRequest(res, "invalid_lead_id");
    return null;
  }
  const [lead] = await db
    .select({ id: leadsTable.id, firm_id: leadsTable.firm_id })
    .from(leadsTable)
    .where(eq(leadsTable.id, leadId));
  if (!lead) {
    notFound(res, "lead_not_found");
    return null;
  }
  const user = req.user;
  // A caller who cannot bypass ownership may ONLY act on a lead that is in
  // their own firm. Unscoped (null-firm) legacy rows are denied outright rather
  // than treated as world-readable — otherwise they'd leak across tenants.
  if (!canBypassOwnership(user) && (lead.firm_id == null || lead.firm_id !== user?.firm_id)) {
    forbidden(res, "cross_firm_lead");
    return null;
  }
  return lead;
}

// GET /leads/:id/status — current stage + most recent audit trail.
router.get(
  "/leads/:id/status",
  requirePermission(Permission.AUTOMATIONS_VIEW),
  async (req, res) => {
    const lead = await loadLeadScoped(req, res);
    if (!lead) return;
    const [row] = await db
      .select({ pipeline_status: leadsTable.pipeline_status })
      .from(leadsTable)
      .where(eq(leadsTable.id, lead.id));
    const events = await db
      .select()
      .from(pipelineEventsTable)
      .where(eq(pipelineEventsTable.lead_id, lead.id))
      .orderBy(desc(pipelineEventsTable.created_at))
      .limit(50);
    res.json({ lead_id: lead.id, pipeline_status: row?.pipeline_status ?? null, events });
  },
);

// `npi`/`expected` are `.nullish()` (accept null AND undefined): the n8n
// orchestrator forwards only `lead_id` and renders absent provider fields as
// JSON `null`, and the CRM sources the real identifiers from the lead's stored
// fields via `withStoredProviderFallback`. null is normalized to undefined below
// so a `{ "npi": null }` body is a valid "no signal" call, not a 400.
const intakeCompletedSchema = z.object({
  npi: z.string().trim().min(1).nullish(),
  expected: z
    .object({
      name: z.string().optional(),
      organization: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      specialty: z.string().optional(),
    })
    .nullish(),
  key_suffix: z.string().optional(),
});

// POST /leads/:id/intake-completed — INTAKE_COMPLETED → NPI verification.
router.post(
  "/leads/:id/intake-completed",
  requirePermission(Permission.AUTOMATIONS_EXECUTE),
  async (req, res) => {
    const lead = await loadLeadScoped(req, res);
    if (!lead) return;
    const parsed = intakeCompletedSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badRequest(res, "invalid_body", parsed.error.issues);
      return;
    }
    const out = await completeIntake(
      lead.id,
      { npi: parsed.data.npi ?? undefined, expected: parsed.data.expected ?? {} },
      { keySuffix: parsed.data.key_suffix, source: "callback:intake_completed" },
    );
    res.json({ ok: true, npi_verdict: out.npiVerdict ?? null });
  },
);

const keyedSchema = z.object({ key_suffix: z.string().min(1) });

// POST /leads/:id/docs-signed — manual e-sign fan-out fallback.
router.post(
  "/leads/:id/docs-signed",
  requirePermission(Permission.AUTOMATIONS_EXECUTE),
  async (req, res) => {
    const lead = await loadLeadScoped(req, res);
    if (!lead) return;
    const parsed = keyedSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badRequest(res, "key_suffix_required", parsed.error.issues);
      return;
    }
    await applyDocumentsSigned(lead.id, {
      keySuffix: parsed.data.key_suffix,
      source: "callback:docs_signed",
    });
    res.json({ ok: true });
  },
);

// POST /leads/:id/med-recs-received — manual inbound-fax fallback.
router.post(
  "/leads/:id/med-recs-received",
  requirePermission(Permission.AUTOMATIONS_EXECUTE),
  async (req, res) => {
    const lead = await loadLeadScoped(req, res);
    if (!lead) return;
    const parsed = keyedSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badRequest(res, "key_suffix_required", parsed.error.issues);
      return;
    }
    await applyMedRecordsReceived(lead.id, {
      keySuffix: parsed.data.key_suffix,
      source: "callback:med_recs_received",
    });
    res.json({ ok: true });
  },
);

export default router;
