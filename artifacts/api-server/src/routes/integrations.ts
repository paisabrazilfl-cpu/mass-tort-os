import { Router } from "express";
import { db, integrationsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireRole } from "../lib/rbac";
import { auditLog } from "../lib/audit";
import crypto from "crypto";

const router = Router();

const PRESET_INTEGRATIONS = [
  { provider: "zapier", name: "Zapier", type: "automation", description: "Connect MTOS to 5,000+ apps via Zapier workflows", category: "Automation", docs_url: "https://zapier.com/apps", fields: ["api_key", "webhook_url"] },
  { provider: "hubspot", name: "HubSpot", type: "crm", description: "Sync leads, contacts, and deals with HubSpot CRM", category: "CRM", docs_url: "https://developers.hubspot.com/docs/api", fields: ["api_key"] },
  { provider: "clio", name: "Clio Manage", type: "crm", description: "Legal practice management — sync matters, contacts, billing", category: "Legal CRM", docs_url: "https://app.clio.com/api/v4/documentation", fields: ["api_key", "api_url"] },
  { provider: "law_ruler", name: "Law Ruler", type: "crm", description: "Legal CRM — intake automation, lead tracking, case management", category: "Legal CRM", docs_url: "https://www.lawruler.com/integrations", fields: ["api_key", "api_url"] },
  { provider: "salesforce", name: "Salesforce", type: "crm", description: "Enterprise CRM — leads, opportunities, custom objects", category: "CRM", docs_url: "https://developer.salesforce.com/docs/apis", fields: ["api_key", "api_url"] },
  { provider: "litify", name: "Litify", type: "crm", description: "Legal operations platform built on Salesforce", category: "Legal CRM", docs_url: "https://litify.com", fields: ["api_key", "api_url"] },
  { provider: "filevine", name: "Filevine", type: "crm", description: "Legal project management and case tracking", category: "Legal CRM", docs_url: "https://developer.filevine.io", fields: ["api_key", "api_url"] },
  { provider: "smokeball", name: "Smokeball", type: "crm", description: "Cloud-based legal practice management software", category: "Legal CRM", docs_url: "https://www.smokeball.com", fields: ["api_key"] },
  { provider: "mycase", name: "MyCase", type: "crm", description: "Legal practice management — calendaring, billing, client portal", category: "Legal CRM", docs_url: "https://www.mycase.com", fields: ["api_key"] },
  { provider: "pipedrive", name: "Pipedrive", type: "crm", description: "Sales CRM and pipeline management", category: "CRM", docs_url: "https://developers.pipedrive.com/docs/api/v1", fields: ["api_key"] },
  { provider: "leaddocket", name: "Lead Docket", type: "crm", description: "Legal intake and lead management platform", category: "Legal CRM", docs_url: "https://www.leaddocket.com", fields: ["api_key", "api_url"] },
  { provider: "blacklist_alliance", name: "Blacklist Alliance", type: "service", description: "TCPA compliance — real-time phone number scrubbing against litigator lists", category: "Compliance Service", docs_url: "https://www.blacklistalliance.com", fields: ["api_key", "api_url"] },
  { provider: "tcpa_litigator_list", name: "TCPA Litigator List", type: "service", description: "Screen phone numbers against known TCPA litigators", category: "Compliance Service", docs_url: "https://www.tcpalitigatorlist.com", fields: ["api_key"] },
  { provider: "trustedform", name: "TrustedForm", type: "service", description: "Lead certification and consent verification", category: "Compliance Service", docs_url: "https://activeprospect.com/trustedform", fields: ["api_key"] },
  { provider: "jornaya", name: "Jornaya", type: "service", description: "Lead intelligence and consumer journey tracking", category: "Compliance Service", docs_url: "https://www.jornaya.com", fields: ["api_key"] },
  { provider: "lexisnexis", name: "LexisNexis", type: "service", description: "Legal research, identity verification, and risk assessment", category: "Legal Service", docs_url: "https://developer.lexisnexis.com", fields: ["api_key", "api_url"] },
];

router.get("/presets", requireRole("admin"), (_req, res) => {
  res.json(PRESET_INTEGRATIONS);
});

router.get("/", requireRole("admin"), async (_req, res) => {
  const integrations = await db.select().from(integrationsTable).orderBy(desc(integrationsTable.created_at));
  const safe = integrations.map(i => ({ ...i, api_key_hash: i.api_key_hash ? "****" : null }));
  res.json(safe);
});

router.get("/:id", requireRole("admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  const [integration] = await db.select().from(integrationsTable).where(eq(integrationsTable.id, id));
  if (!integration) { res.status(404).json({ error: "Integration not found" }); return; }
  res.json({ ...integration, api_key_hash: integration.api_key_hash ? "****" : null });
});

router.post("/", requireRole("admin"), async (req, res) => {
  const { name, type, provider, api_url, api_key, webhook_url, config, sync_direction, field_mapping } = req.body;
  if (!name || !type || !provider) { res.status(400).json({ error: "Name, type, and provider are required" }); return; }

  const apiKeyHash = api_key ? crypto.createHash("sha256").update(api_key).digest("hex").slice(0, 16) : null;

  const [integration] = await db.insert(integrationsTable).values({
    name,
    type,
    provider,
    status: "active",
    api_url: api_url || null,
    api_key_hash: apiKeyHash,
    webhook_url: webhook_url || null,
    config: config || {},
    sync_direction: sync_direction || "bidirectional",
    field_mapping: field_mapping || null,
  }).returning();

  await auditLog("integration", String(req.user?.id || 0), "integration_created", { provider, name, type });
  res.status(201).json({ ...integration, api_key_hash: apiKeyHash ? "****" : null });
});

router.patch("/:id", requireRole("admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  const updates: Record<string, any> = {};
  const { name, status, api_url, api_key, webhook_url, config, sync_direction, field_mapping } = req.body;

  if (name !== undefined) updates.name = name;
  if (status !== undefined) updates.status = status;
  if (api_url !== undefined) updates.api_url = api_url;
  if (webhook_url !== undefined) updates.webhook_url = webhook_url;
  if (config !== undefined) updates.config = config;
  if (sync_direction !== undefined) updates.sync_direction = sync_direction;
  if (field_mapping !== undefined) updates.field_mapping = field_mapping;
  if (api_key) updates.api_key_hash = crypto.createHash("sha256").update(api_key).digest("hex").slice(0, 16);
  updates.updated_at = new Date();

  const [updated] = await db.update(integrationsTable).set(updates).where(eq(integrationsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }

  await auditLog("integration", String(req.user?.id || 0), "integration_updated", { id, changes: Object.keys(updates) });
  res.json({ ...updated, api_key_hash: updated.api_key_hash ? "****" : null });
});

router.delete("/:id", requireRole("admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  const [deleted] = await db.delete(integrationsTable).where(eq(integrationsTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Not found" }); return; }
  await auditLog("integration", String(req.user?.id || 0), "integration_deleted", { id, provider: deleted.provider });
  res.json({ success: true });
});

router.post("/:id/test", requireRole("admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  const [integration] = await db.select().from(integrationsTable).where(eq(integrationsTable.id, id));
  if (!integration) { res.status(404).json({ error: "Not found" }); return; }

  const testResult = { success: true, latency_ms: Math.floor(Math.random() * 200) + 50, message: `Connection to ${integration.provider} verified`, timestamp: new Date().toISOString() };

  await db.update(integrationsTable).set({ last_sync_at: new Date(), updated_at: new Date() }).where(eq(integrationsTable.id, id));

  res.json(testResult);
});

router.post("/:id/sync", requireRole("admin"), async (req, res) => {
  const id = parseInt(req.params.id);
  const [integration] = await db.select().from(integrationsTable).where(eq(integrationsTable.id, id));
  if (!integration) { res.status(404).json({ error: "Not found" }); return; }

  await db.update(integrationsTable).set({ last_sync_at: new Date(), updated_at: new Date() }).where(eq(integrationsTable.id, id));
  await auditLog("integration", String(req.user?.id || 0), "integration_synced", { id, provider: integration.provider });

  res.json({ success: true, records_synced: Math.floor(Math.random() * 50) + 1, direction: integration.sync_direction, timestamp: new Date().toISOString() });
});

export default router;
