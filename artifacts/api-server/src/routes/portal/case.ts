import { Router } from "express";
import { db, leadsTable, documentsTable, documentEnvelopesTable, faxEventsTable, faxResultsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { unauthorized, notFound } from "../../lib/http-errors";
import { portalAuthMiddleware, requirePortalMfa, writePortalAudit, getClientIp } from "../../lib/portal-auth";

const router = Router();

// All case routes require portal auth + MFA verified.
router.use(portalAuthMiddleware);
router.use(requirePortalMfa);

// ---------------------------------------------------------------------------
// GET /portal/case
// Case status overview + timeline. Returns only the fields the client needs —
// no raw PHI beyond what they submitted, no internal scoring, no staff notes.
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const pu = req.portalUser!;

  const [lead] = await db
    .select({
      id: leadsTable.id,
      status: leadsTable.status,
      tort_type: leadsTable.tort_type,
      created_at: leadsTable.created_at,
      background_check_status: leadsTable.background_check_status,
      physician_first_name: leadsTable.physician_first_name,
      physician_last_name: leadsTable.physician_last_name,
      hospital_name: leadsTable.hospital_name,
      npi_verified: leadsTable.npi_verified,
      diagnosis_confirmed: leadsTable.diagnosis_confirmed,
    })
    .from(leadsTable)
    .where(eq(leadsTable.id, pu.lead_id));

  if (!lead) {
    notFound(res, "Case not found");
    return;
  }

  // All e-sign envelopes for this lead — used to derive signing milestones.
  const envelopes = await db
    .select({
      status: documentEnvelopesTable.status,
      sent_at: documentEnvelopesTable.sent_at,
      signed_at: documentEnvelopesTable.signed_at,
    })
    .from(documentEnvelopesTable)
    .where(eq(documentEnvelopesTable.lead_id, pu.lead_id));

  // Outbound fax events (HIPAA request to doctor) — check for sent/delivered.
  const faxSentEvents = await db
    .select({ event_type: faxEventsTable.event_type, occurred_at: faxEventsTable.occurred_at })
    .from(faxEventsTable)
    .where(
      and(
        eq(faxEventsTable.lead_id, pu.lead_id),
        inArray(faxEventsTable.event_type, ["sent", "delivered", "queued"]),
      ),
    );

  // Medical records received via fax (fax_results matched to this lead).
  const faxRecordsReceived = await db
    .select({ id: faxResultsTable.id, created_at: faxResultsTable.created_at })
    .from(faxResultsTable)
    .where(
      and(
        eq(faxResultsTable.lead_id, pu.lead_id),
        inArray(faxResultsTable.status, ["processed", "complete"]),
      ),
    );

  // Documents of medical record types attached to this lead.
  const medRecDocs = await db
    .select({ id: documentsTable.id, created_at: documentsTable.created_at })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.lead_id, pu.lead_id),
        inArray(documentsTable.document_type, [
          "medical_record", "pharmacy_record", "lab_result",
          "radiology", "discharge_summary", "operative_report",
          "pathology", "med_rec", "fax_return",
        ]),
      ),
    );

  // Build timeline — each step has a label, status, and optional date.
  const allSent = envelopes.length > 0;
  const firstSentAt = envelopes.reduce<Date | null>((min, e) => {
    if (!e.sent_at) return min;
    return !min || e.sent_at < min ? e.sent_at : min;
  }, null);
  const allSigned = envelopes.length > 0 && envelopes.every(e => e.status === "signed");
  const lastSignedAt = envelopes.reduce<Date | null>((max, e) => {
    if (!e.signed_at) return max;
    return !max || e.signed_at > max ? e.signed_at : max;
  }, null);
  const faxRequestedAt = faxSentEvents[0]?.occurred_at ?? null;
  const medRecsReceived = faxRecordsReceived.length > 0 || medRecDocs.length > 0;
  const firstMedRecAt = [
    ...faxRecordsReceived.map(r => r.created_at),
    ...medRecDocs.map(d => d.created_at),
  ].sort()[0] ?? null;

  const timeline = [
    {
      step: "application_submitted",
      label: "Application Submitted",
      status: "complete",
      date: lead.created_at,
    },
    {
      step: "background_check",
      label: "Background Check",
      status:
        lead.background_check_status === "clean" ? "complete"
        : lead.background_check_status === "flagged" ? "review"
        : lead.background_check_status === "error" ? "review"
        : "pending",
      date: null,
    },
    {
      step: "documents_sent",
      label: "Documents Sent for Signing",
      status: allSent ? "complete" : lead.background_check_status === "clean" ? "pending" : "waiting",
      date: firstSentAt,
    },
    {
      step: "documents_signed",
      label: "Documents Signed",
      status: allSigned ? "complete" : allSent ? "action_required" : "waiting",
      date: lastSignedAt,
    },
    {
      step: "records_requested",
      label: "Medical Records Requested",
      status: faxRequestedAt ? "complete" : allSigned ? "pending" : "waiting",
      date: faxRequestedAt,
    },
    {
      step: "records_received",
      label: "Medical Records Received",
      status: medRecsReceived ? "complete" : "waiting",
      date: firstMedRecAt ?? null,
    },
    {
      step: "case_review",
      label: "Attorney Review",
      status: medRecsReceived ? "pending" : "waiting",
      date: null,
    },
  ];

  await writePortalAudit({
    portal_user_id: pu.id,
    admin_user_id: pu.impersonation ? pu.admin_id : null,
    lead_id: pu.lead_id,
    firm_id: pu.firm_id,
    action: "portal.view_case",
    ip: getClientIp(req),
    user_agent: req.headers["user-agent"],
  });

  res.json({
    case: {
      id: lead.id,
      tort_type: lead.tort_type,
      status: lead.status,
      created_at: lead.created_at,
      physician: lead.physician_first_name || lead.physician_last_name
        ? `${lead.physician_first_name ?? ""} ${lead.physician_last_name ?? ""}`.trim()
        : null,
      hospital_name: lead.hospital_name ?? null,
      documents: {
        total: envelopes.length,
        signed: envelopes.filter(e => e.status === "signed").length,
        pending: envelopes.filter(e => e.status !== "signed" && e.status !== "declined").length,
      },
      medical_records: {
        fax_records_count: faxRecordsReceived.length,
        document_records_count: medRecDocs.length,
        received: medRecsReceived,
      },
    },
    timeline,
  });
});

export default router;
