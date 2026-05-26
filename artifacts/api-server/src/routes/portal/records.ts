import { Router } from "express";
import { db, documentsTable, faxResultsTable, medicalRecordsRequestsTable } from "@workspace/db";
import { eq, and, inArray, ne } from "drizzle-orm";
import { portalAuthMiddleware, requirePortalMfa, writePortalAudit, getClientIp } from "../../lib/portal-auth";

const router = Router();

router.use(portalAuthMiddleware);
router.use(requirePortalMfa);

const MED_REC_TYPES = [
  "medical_record", "pharmacy_record", "lab_result",
  "radiology", "discharge_summary", "operative_report",
  "pathology", "med_rec", "fax_return",
];

// ---------------------------------------------------------------------------
// GET /portal/records
// Medical records status: records received via fax/upload.
// No raw file content or URLs are returned — the client sees status and
// metadata only.
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const pu = req.portalUser!;

  // Medical record documents attached to this lead.
  const medDocs = await db
    .select({
      id: documentsTable.id,
      document_type: documentsTable.document_type,
      file_name: documentsTable.file_name,
      created_at: documentsTable.created_at,
    })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.lead_id, pu.lead_id),
        inArray(documentsTable.document_type, MED_REC_TYPES),
      ),
    )
    .orderBy(documentsTable.created_at);

  // Outbound MRR requests sent on behalf of this lead.
  const mrrRequests = await db
    .select({
      id: medicalRecordsRequestsTable.id,
      hospital_name: medicalRecordsRequestsTable.hospital_name,
      fax_number: medicalRecordsRequestsTable.fax_number,
      status: medicalRecordsRequestsTable.status,
      sent_at: medicalRecordsRequestsTable.sent_at,
      expected_by: medicalRecordsRequestsTable.expected_by,
      fulfilled_at: medicalRecordsRequestsTable.fulfilled_at,
      attempt_count: medicalRecordsRequestsTable.attempt_count,
    })
    .from(medicalRecordsRequestsTable)
    .where(
      and(
        eq(medicalRecordsRequestsTable.lead_id, pu.lead_id),
        ne(medicalRecordsRequestsTable.status, "cancelled"),
      ),
    )
    .orderBy(medicalRecordsRequestsTable.created_at);

  // Fax results matched to this lead (OCR-processed inbound faxes).
  const faxRecords = await db
    .select({
      id: faxResultsTable.id,
      drug_name: faxResultsTable.drug_name,
      status: faxResultsTable.status,
      confidence: faxResultsTable.confidence,
      created_at: faxResultsTable.created_at,
      processed_at: faxResultsTable.processed_at,
    })
    .from(faxResultsTable)
    .where(eq(faxResultsTable.lead_id, pu.lead_id))
    .orderBy(faxResultsTable.created_at);

  await writePortalAudit({
    portal_user_id: pu.id,
    admin_user_id: pu.impersonation ? pu.admin_id : null,
    lead_id: pu.lead_id,
    firm_id: pu.firm_id,
    action: "portal.view_records",
    ip: getClientIp(req),
    user_agent: req.headers["user-agent"],
  });

  const totalReceived = medDocs.length + faxRecords.filter(f => f.status !== "error").length;

  const now = new Date();
  const pendingRequests = mrrRequests.filter(r => r.status === "pending" || r.status === "sent");
  const overdueRequests = pendingRequests.filter(r => r.expected_by && new Date(r.expected_by) < now);

  res.json({
    records: {
      documents: medDocs.map(d => ({
        id: d.id,
        type: d.document_type,
        type_label: friendlyRecordType(d.document_type),
        file_name: d.file_name,
        received_at: d.created_at,
      })),
      fax_results: faxRecords.map(f => ({
        id: f.id,
        status: f.status,
        drug_name: f.drug_name || null,
        confidence: f.confidence,
        received_at: f.created_at,
        processed_at: f.processed_at,
      })),
      total_received: totalReceived,
    },
    requests: mrrRequests.map(r => ({
      id: r.id,
      hospital_name: r.hospital_name || "Medical Provider",
      status: r.status,
      sent_at: r.sent_at,
      expected_by: r.expected_by,
      fulfilled_at: r.fulfilled_at,
      overdue: r.status === "sent" && !!r.expected_by && new Date(r.expected_by) < now,
    })),
    summary: {
      records_received: totalReceived,
      requests_pending: pendingRequests.length,
      requests_overdue: overdueRequests.length,
    },
  });
});

function friendlyRecordType(type: string): string {
  const map: Record<string, string> = {
    medical_record: "Medical Record",
    pharmacy_record: "Pharmacy Record",
    lab_result: "Lab Result",
    radiology: "Radiology Report",
    discharge_summary: "Discharge Summary",
    operative_report: "Operative Report",
    pathology: "Pathology Report",
    med_rec: "Medical Record",
    fax_return: "Faxed Record",
  };
  return map[type] ?? "Medical Record";
}

export default router;
