import { Router } from "express";
import {
  db,
  importBatchesTable,
  importRowsTable,
  leadsTable,
  dialerCampaignsTable,
  dialerCampaignLeadsTable,
  tortVoiceAgentsTable,
} from "@workspace/db";
import { and, desc, eq, ilike, inArray } from "drizzle-orm";
import { Permission, requirePermission } from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { serverError } from "../lib/http-errors";
import { decryptLeadFields } from "../lib/encryption";
import { enqueueJob } from "../lib/queue";
import {
  LEAD_FIELDS,
  parseCSV,
  autoMapColumns,
  mapRowToLead,
  processImportBatch,
} from "../lib/lead-import-core";

const router = Router();
const OUTREACH_PREFIX = "[outreach]";

function outreachFilename(filename: string) {
  return `${OUTREACH_PREFIX} ${filename}`;
}

function buildLeadName(lead: Record<string, any>) {
  return lead.name || `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() || "there";
}

function buildEmailSubject(lead: Record<string, any>, override?: string | null) {
  if (override && override.trim()) return override.trim();
  return `Complete your ${lead.tort_type || "claim"} re-intake`;
}

function buildEmailHtml(lead: Record<string, any>, tortPageUrl: string) {
  const name = buildLeadName(lead);
  const tortLabel = lead.tort_type || "claim";
  return [
    `<p>Hi ${name},</p>`,
    `<p>We are reaching out to continue your ${tortLabel} intake. Please review the case page below and complete your re-intake when you are ready.</p>`,
    `<p><a href="${tortPageUrl}">Open your ${tortLabel} intake page</a></p>`,
    `<p>If you would rather finish by phone, our intake team may follow up with a call.</p>`,
    `<p>Thank you,<br />Intake Team</p>`,
  ].join("");
}

function buildEmailText(lead: Record<string, any>, tortPageUrl: string) {
  const name = buildLeadName(lead);
  const tortLabel = lead.tort_type || "claim";
  return `Hi ${name},\n\nWe are reaching out to continue your ${tortLabel} intake. Please review the case page and complete your re-intake here: ${tortPageUrl}\n\nThank you,\nIntake Team`;
}

function buildSmsBody(lead: Record<string, any>, tortPageUrl: string, override?: string | null) {
  if (override && override.trim()) return override.trim();
  const name = buildLeadName(lead);
  const tortLabel = lead.tort_type || "claim";
  return `Hi ${name}, please complete your ${tortLabel} re-intake here: ${tortPageUrl} Reply STOP to opt out.`;
}

router.post("/preview", requirePermission(Permission.LEAD_IMPORT_PREVIEW), async (req, res) => {
  try {
    const { csv_data } = req.body ?? {};
    if (!csv_data) {
      res.status(400).json({ error: "csv_data is required" });
      return;
    }

    const { headers, rows } = parseCSV(csv_data);
    if (headers.length === 0) {
      res.status(400).json({ error: "No valid CSV headers found" });
      return;
    }

    const columnMapping = autoMapColumns(headers);
    const unmappedColumns = headers.filter((h) => !columnMapping[h]);
    const sampleRows = rows.slice(0, 5).map((row) => mapRowToLead(row, columnMapping));

    res.json({
      total_rows: rows.length,
      headers,
      column_mapping: columnMapping,
      unmapped_columns: unmappedColumns,
      available_fields: Array.from(LEAD_FIELDS),
      sample_leads: sampleRows,
    });
  } catch (err) {
    logger.error({ err }, "Outreach preview failed");
    serverError(res, "Failed to preview outreach file");
  }
});

router.post("/execute", requirePermission(Permission.LEAD_IMPORT_EXECUTE), async (req, res) => {
  try {
    const {
      csv_data,
      column_mapping,
      filename = "outreach.csv",
      tort_page_url,
      email_enabled = true,
      sms_enabled = true,
      voice_enabled = false,
      email_subject,
      sms_message,
    } = req.body ?? {};

    if (!csv_data) {
      res.status(400).json({ error: "csv_data is required" });
      return;
    }
    if (!tort_page_url || typeof tort_page_url !== "string") {
      res.status(400).json({ error: "tort_page_url is required" });
      return;
    }
    if (!email_enabled && !sms_enabled && !voice_enabled) {
      res.status(400).json({ error: "Select at least one outreach channel" });
      return;
    }

    const { headers, rows } = parseCSV(csv_data);
    if (rows.length === 0) {
      res.status(400).json({ error: "No data rows found in CSV" });
      return;
    }
    if (rows.length > 5000) {
      res.status(400).json({ error: `Outreach limited to 5000 rows per batch. This file has ${rows.length} rows.` });
      return;
    }

    const mapping = column_mapping || autoMapColumns(headers);
    const user = req.user!;

    const [batch] = await db
      .insert(importBatchesTable)
      .values({
        filename: outreachFilename(filename),
        status: "processing",
        total_rows: rows.length,
        column_mapping: mapping,
        created_by: user.email,
      })
      .returning();

    await auditLog("import_batch", String(batch.id), "outreach_started", {
      filename,
      total_rows: rows.length,
      email_enabled,
      sms_enabled,
      voice_enabled,
      user_email: user.email,
    });

    res.status(202).json({
      batch_id: batch.id,
      status: "processing",
      total_rows: rows.length,
      message: "Outreach accepted. Leads will be upserted, then eligible contacts will receive the selected re-intake outreach.",
    });

    void (async () => {
      try {
        const summary = await processImportBatch(batch.id, rows, mapping, user.firm_id, {
          duplicateMode: "upsert",
          source: "outreach_csv",
        });

        if (summary.touchedLeadIds.length === 0) {
          await auditLog("import_batch", String(batch.id), "outreach_completed", {
            created: summary.createdLeadIds.length,
            updated: summary.updatedLeadIds.length,
            contacted: 0,
          });
          return;
        }

        const leadRows = await db
          .select()
          .from(leadsTable)
          .where(inArray(leadsTable.id, summary.touchedLeadIds));

        const decryptedLeads = leadRows.map((lead) => decryptLeadFields(lead, String(lead.id)));

        let emailJobs = 0;
        let smsJobs = 0;
        let voiceCampaigns = 0;

        for (const lead of decryptedLeads) {
          const leadName = buildLeadName(lead);
          const hasSmsConsent = lead.tcpa_consent === true;

          if (email_enabled && typeof lead.email === "string" && lead.email.trim()) {
            await enqueueJob("send_workflow_email", {
              lead_id: lead.id,
              to: lead.email.trim(),
              to_name: leadName,
              subject: buildEmailSubject(lead, email_subject),
              html: buildEmailHtml(lead, tort_page_url),
              text: buildEmailText(lead, tort_page_url),
            });
            emailJobs++;
          }

          if (sms_enabled && hasSmsConsent) {
            await enqueueJob("send_workflow_sms", {
              lead_id: lead.id,
              firm_id: user.firm_id,
              body: buildSmsBody(lead, tort_page_url, sms_message),
              source: "outreach_reintake",
            });
            smsJobs++;
          }
        }

        if (voice_enabled) {
          const eligibleVoiceLeads = decryptedLeads.filter((lead) => {
            const hasPhone = typeof lead.phone === "string" || typeof lead.phone_primary === "string";
            return lead.tcpa_consent === true && hasPhone;
          });

          const leadsByTort = new Map<string, number[]>();
          for (const lead of eligibleVoiceLeads) {
            const tortKey = typeof lead.tort_type === "string" && lead.tort_type.trim() ? lead.tort_type.trim() : "general";
            const current = leadsByTort.get(tortKey) ?? [];
            current.push(lead.id);
            leadsByTort.set(tortKey, current);
          }

          for (const [tort, leadIds] of leadsByTort.entries()) {
            let assistantId: string | null = null;
            if (tort !== "general") {
              const [agent] = await db
                .select()
                .from(tortVoiceAgentsTable)
                .where(eq(tortVoiceAgentsTable.tort_id, tort))
                .limit(1);
              if (agent?.vapi_assistant_id && agent.status === "active") {
                assistantId = agent.vapi_assistant_id;
              }
            }

            const [campaign] = await db
              .insert(dialerCampaignsTable)
              .values({
                firm_id: user.firm_id,
                created_by: user.id,
                name: `Outreach Re-Intake · ${tort} · Batch ${batch.id}`,
                type: "preview",
                status: "active",
                total_leads: leadIds.length,
                notes: `Auto-created from outreach batch ${batch.id}. Page: ${tort_page_url}`,
                vapi_assistant_id: assistantId,
              })
              .returning();

            await db
              .insert(dialerCampaignLeadsTable)
              .values(leadIds.map((leadId) => ({ campaign_id: campaign.id, lead_id: leadId })))
              .onConflictDoNothing();

            await enqueueJob("dialer_campaign_run", { campaign_id: campaign.id });
            voiceCampaigns++;
          }
        }

        await auditLog("import_batch", String(batch.id), "outreach_completed", {
          created: summary.createdLeadIds.length,
          updated: summary.updatedLeadIds.length,
          email_jobs: emailJobs,
          sms_jobs: smsJobs,
          voice_campaigns: voiceCampaigns,
        });
      } catch (err) {
        logger.error({ err, batch_id: batch.id }, "Outreach batch execution failed");
      }
    })();
  } catch (err) {
    logger.error({ err }, "Failed to start outreach");
    serverError(res, "Failed to start outreach");
  }
});

router.get("/batches", requirePermission(Permission.LEAD_IMPORT_PREVIEW), async (_req, res) => {
  try {
    const batches = await db
      .select()
      .from(importBatchesTable)
      .where(ilike(importBatchesTable.filename, `${OUTREACH_PREFIX}%`))
      .orderBy(desc(importBatchesTable.created_at))
      .limit(50);
    res.json(batches);
  } catch (err) {
    logger.error({ err }, "Failed to list outreach batches");
    serverError(res, "Failed to list outreach batches");
  }
});

router.get("/batches/:id", requirePermission(Permission.LEAD_IMPORT_PREVIEW), async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    const [batch] = await db
      .select()
      .from(importBatchesTable)
      .where(and(eq(importBatchesTable.id, batchId), ilike(importBatchesTable.filename, `${OUTREACH_PREFIX}%`)));

    if (!batch) {
      res.status(404).json({ error: "Batch not found" });
      return;
    }

    const rows = await db
      .select()
      .from(importRowsTable)
      .where(eq(importRowsTable.batch_id, batch.id))
      .orderBy(importRowsTable.row_number);

    res.json({ ...batch, rows });
  } catch (err) {
    logger.error({ err }, "Failed to get outreach batch details");
    serverError(res, "Failed to get outreach batch details");
  }
});

export default router;
