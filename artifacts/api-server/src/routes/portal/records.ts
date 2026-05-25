import { Router } from "express";
import { db, documentsTable, faxResultsTable, fastenConnectionsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
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
// Medical records status: records received via fax/upload, and FHIR provider
// connections via Fasten. No raw file content or URLs are returned — the
// client sees status and metadata only.
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

  // Fasten Health provider connections for this lead.
  // These are patient-initiated FHIR connections — the client can see which
  // providers are connected and the last sync status.
  const fastenConnections = await db
    .select({
      id: fastenConnectionsTable.id,
      portal_name: fastenConnectionsTable.portal_name,
      portal_id: fastenConnectionsTable.portal_id,
      status: fastenConnectionsTable.status,
      last_synced_at: fastenConnectionsTable.last_synced_at,
      last_resource_count: fastenConnectionsTable.last_resource_count,
      last_error: fastenConnectionsTable.last_error,
      created_at: fastenConnectionsTable.created_at,
    })
    .from(fastenConnectionsTable)
    .where(eq(fastenConnectionsTable.lead_id, pu.lead_id))
    .orderBy(fastenConnectionsTable.created_at);

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

  res.json({
    // Traditional fax / uploaded medical records
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
    // FHIR provider connections (Fasten Health)
    providers: fastenConnections.map(c => ({
      id: c.id,
      name: c.portal_name ?? c.portal_id ?? "Healthcare Provider",
      status: c.status,
      status_label: friendlyConnectionStatus(c.status),
      // Only show last_error when the connection is in error state —
      // no internal error details that could confuse the client.
      needs_attention: ["reauth", "error"].includes(c.status),
      last_synced_at: c.last_synced_at,
      records_count: c.last_resource_count ?? 0,
      connected_at: c.created_at,
    })),
    summary: {
      records_received: totalReceived,
      providers_connected: fastenConnections.filter(c => c.status === "active" || c.status === "synced").length,
      providers_needing_attention: fastenConnections.filter(c => ["reauth", "error"].includes(c.status)).length,
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

function friendlyConnectionStatus(status: string): string {
  const map: Record<string, string> = {
    pending: "Connecting",
    active: "Connected",
    syncing: "Syncing Records",
    synced: "Records Retrieved",
    reauth: "Reconnection Required",
    revoked: "Disconnected",
    error: "Connection Error",
  };
  return map[status] ?? status;
}

export default router;
