import { Router } from "express";
import { db, documentEnvelopesTable, documentsTable, documentTemplatesTable } from "@workspace/db";
import { eq, and, notInArray } from "drizzle-orm";
import { notFound } from "../../lib/http-errors";
import { portalAuthMiddleware, requirePortalMfa, writePortalAudit, getClientIp } from "../../lib/portal-auth";

const router = Router();

router.use(portalAuthMiddleware);
router.use(requirePortalMfa);

// ---------------------------------------------------------------------------
// GET /portal/documents
// Returns all e-sign envelopes + supporting documents for this lead.
// Signing happens via DocuSign email links — the portal shows STATUS only.
// No raw file URLs are returned (internal paths stay internal).
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const pu = req.portalUser!;

  // Fetch envelopes joined with template name for display.
  const envelopes = await db
    .select({
      id: documentEnvelopesTable.id,
      provider: documentEnvelopesTable.provider,
      status: documentEnvelopesTable.status,
      status_detail: documentEnvelopesTable.status_detail,
      sent_at: documentEnvelopesTable.sent_at,
      delivered_at: documentEnvelopesTable.delivered_at,
      viewed_at: documentEnvelopesTable.viewed_at,
      signed_at: documentEnvelopesTable.signed_at,
      declined_at: documentEnvelopesTable.declined_at,
      template_name: documentTemplatesTable.name,
      template_type: documentTemplatesTable.template_type,
      created_at: documentEnvelopesTable.created_at,
    })
    .from(documentEnvelopesTable)
    .leftJoin(documentTemplatesTable, eq(documentEnvelopesTable.template_id, documentTemplatesTable.id))
    .where(eq(documentEnvelopesTable.lead_id, pu.lead_id))
    .orderBy(documentEnvelopesTable.created_at);

  // Non-envelope documents attached to this lead (uploaded files, received records).
  // Exclude internal-only types that should not be surfaced to clients.
  const MED_REC_TYPES = [
    "medical_record", "pharmacy_record", "lab_result",
    "radiology", "discharge_summary", "operative_report",
    "pathology", "med_rec", "fax_return",
  ];
  const supportingDocs = await db
    .select({
      id: documentsTable.id,
      document_type: documentsTable.document_type,
      file_name: documentsTable.file_name,
      signed: documentsTable.signed,
      signed_at: documentsTable.signed_at,
      created_at: documentsTable.created_at,
    })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.lead_id, pu.lead_id),
        // Exclude raw med-rec documents here — they appear in /portal/records instead.
        notInArray(documentsTable.document_type, MED_REC_TYPES),
      ),
    )
    .orderBy(documentsTable.created_at);

  await writePortalAudit({
    portal_user_id: pu.id,
    admin_user_id: pu.impersonation ? pu.admin_id : null,
    lead_id: pu.lead_id,
    firm_id: pu.firm_id,
    action: "portal.view_document",
    ip: getClientIp(req),
    user_agent: req.headers["user-agent"],
  });

  // Map envelope status to a client-friendly label.
  function friendlyEnvelopeStatus(status: string): string {
    const map: Record<string, string> = {
      created: "Preparing",
      sent: "Awaiting Your Signature",
      delivered: "Awaiting Your Signature",
      viewed: "Opened — Awaiting Signature",
      signed: "Signed",
      declined: "Declined",
      expired: "Expired",
      voided: "Voided",
      error: "Error",
    };
    return map[status] ?? status;
  }

  res.json({
    envelopes: envelopes.map(e => ({
      id: e.id,
      name: e.template_name ?? friendlyDocType(e.template_type ?? "document"),
      provider: e.provider,
      status: e.status,
      status_label: friendlyEnvelopeStatus(e.status),
      action_required: ["sent", "delivered", "viewed"].includes(e.status),
      sent_at: e.sent_at,
      delivered_at: e.delivered_at,
      viewed_at: e.viewed_at,
      signed_at: e.signed_at,
      declined_at: e.declined_at,
      created_at: e.created_at,
    })),
    documents: supportingDocs.map(d => ({
      id: d.id,
      type: d.document_type,
      type_label: friendlyDocType(d.document_type),
      file_name: d.file_name,
      signed: d.signed,
      signed_at: d.signed_at,
      created_at: d.created_at,
    })),
    summary: {
      total_envelopes: envelopes.length,
      signed: envelopes.filter(e => e.status === "signed").length,
      action_required: envelopes.filter(e => ["sent", "delivered", "viewed"].includes(e.status)).length,
    },
  });
});

function friendlyDocType(type: string): string {
  const map: Record<string, string> = {
    hipaa: "HIPAA Authorization",
    hipaa_authorization: "HIPAA Authorization",
    retainer: "Retainer Agreement",
    retainer_agreement: "Retainer Agreement",
    affidavit: "Personal Truth Affidavit",
    truth_affidavit: "Personal Truth Affidavit",
    settlement: "Settlement Agreement",
    demand_letter: "Demand Letter",
    medical_record: "Medical Record",
    pharmacy_record: "Pharmacy Record",
    lab_result: "Lab Result",
    radiology: "Radiology Report",
    discharge_summary: "Discharge Summary",
    operative_report: "Operative Report",
    pathology: "Pathology Report",
    document: "Document",
  };
  return map[type.toLowerCase()] ?? type;
}

export default router;
