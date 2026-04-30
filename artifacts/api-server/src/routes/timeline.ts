import { Router } from "express";
import { db, leadsTable, faxResultsTable, documentsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { decryptLeadFields } from "../lib/encryption";
import { Permission, requirePermission } from "../lib/rbac";

const router = Router();

router.get("/lead/:id", requirePermission(Permission.TIMELINE_VIEW), async (req, res) => {
  const leadId = parseInt(String(req.params.id), 10);
  if (isNaN(leadId)) { res.status(400).json({ error: "Invalid lead ID" }); return; }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  // Task #8: bind AAD to lead.id so a swapped ciphertext from another row
  // fails AES-GCM auth verification instead of silently decrypting.
  const decrypted = decryptLeadFields(lead, String(lead.id));
  const events: { date: string; event: string; category: string; source: string; details?: string }[] = [];

  if (decrypted.date_of_birth) {
    events.push({ date: decrypted.date_of_birth, event: "Date of Birth", category: "personal", source: "intake" });
  }

  if (decrypted.exposure_start) {
    events.push({ date: decrypted.exposure_start, event: `Exposure Start — ${decrypted.tort_type}`, category: "exposure", source: "intake", details: decrypted.location_name || undefined });
  }

  if (decrypted.exposure_end) {
    events.push({ date: decrypted.exposure_end, event: `Exposure End — ${decrypted.tort_type}`, category: "exposure", source: "intake" });
  }

  if (decrypted.diagnosis_date) {
    events.push({ date: decrypted.diagnosis_date, event: `Diagnosis: ${decrypted.diagnosis || "Unknown"}`, category: "diagnosis", source: "intake", details: decrypted.diagnosis_type || undefined });
  }

  if (decrypted.created_at) {
    events.push({ date: new Date(decrypted.created_at).toISOString().split("T")[0], event: "Lead Intake", category: "legal", source: "system" });
  }

  if (decrypted.npi_verified) {
    events.push({ date: new Date(decrypted.created_at).toISOString().split("T")[0], event: `NPI Verified — Dr. ${decrypted.physician_first_name || ""} ${decrypted.physician_last_name || ""}`.trim(), category: "verification", source: "npi" });
  }

  if (decrypted.tcpa_consent) {
    events.push({ date: decrypted.trustedform_timestamp ? new Date(decrypted.trustedform_timestamp).toISOString().split("T")[0] : new Date(decrypted.created_at).toISOString().split("T")[0], event: "TCPA Consent Obtained", category: "compliance", source: "form" });
  }

  const documents = await db.select().from(documentsTable).where(eq(documentsTable.lead_id, leadId));
  for (const doc of documents) {
    events.push({
      date: new Date(doc.created_at).toISOString().split("T")[0],
      event: `Document: ${doc.file_name}`,
      category: "document",
      source: "upload",
      details: doc.document_type || undefined,
    });
    if (doc.signed && doc.signed_at) {
      events.push({
        date: new Date(doc.signed_at).toISOString().split("T")[0],
        event: `Document Signed: ${doc.file_name}`,
        category: "legal",
        source: "signature",
      });
    }
  }

  events.sort((a, b) => {
    const da = new Date(a.date).getTime();
    const db2 = new Date(b.date).getTime();
    if (isNaN(da) && isNaN(db2)) return 0;
    if (isNaN(da)) return 1;
    if (isNaN(db2)) return -1;
    return da - db2;
  });

  res.json({
    lead_id: leadId,
    lead_name: decrypted.name,
    tort_type: decrypted.tort_type,
    events,
    summary: {
      total_events: events.length,
      categories: [...new Set(events.map(e => e.category))],
      date_range: events.length > 0 ? { start: events[0]?.date, end: events[events.length - 1]?.date } : null,
    },
  });
});

export default router;
