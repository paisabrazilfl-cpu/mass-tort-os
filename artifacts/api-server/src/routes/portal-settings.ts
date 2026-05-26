import { Router } from "express";
import crypto from "crypto";
import { db, firmPortalConfigsTable, leadsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { authMiddleware, Permission, requirePermission } from "../lib/rbac";
import { z } from "zod/v4";
import { badRequest } from "../lib/http-errors";
import { TORT_REGISTRY } from "../lib/tort-engine";

const router = Router();
router.use(authMiddleware);

const upsertSchema = z.object({
  portal_enabled: z.boolean().default(false),
  brand_name: z.string().max(255).nullish(),
  brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  logo_url: z.string().nullish(),
  fasten_enabled: z.boolean().default(false),
  fasten_backend: z.enum(["onprem", "connect"]).default("onprem"),
  fasten_api_url: z.string().nullish(),
  // Plaintext API key — server hashes before storage. Empty string = clear.
  fasten_api_key: z.string().max(500).nullish(),
});

function sanitizeRow(row: typeof firmPortalConfigsTable.$inferSelect) {
  const { fasten_api_key_hash, ...rest } = row;
  return { ...rest, has_fasten_api_key: !!fasten_api_key_hash };
}

// GET /portal-settings
// Lists all firm_portal_configs plus distinct tort types from leads so the UI
// can show unconfigured tort types and let the admin add them.
router.get("/", requirePermission(Permission.WORKFLOW_SETTINGS_VIEW), async (req, res) => {
  const firmId = req.user!.firm_id;

  const [tortRows, configs] = await Promise.all([
    db
      .selectDistinct({ tort_type: leadsTable.tort_type })
      .from(leadsTable)
      .where(eq(leadsTable.firm_id, firmId))
      .orderBy(asc(leadsTable.tort_type)),
    db
      .select()
      .from(firmPortalConfigsTable)
      .where(eq(firmPortalConfigsTable.firm_id, firmId))
      .orderBy(asc(firmPortalConfigsTable.tort_type)),
  ]);

  const fromLeads = tortRows.map(r => r.tort_type).filter(Boolean) as string[];
  const fromConfigs = configs.map(c => c.tort_type);
  const fromRegistry = Object.values(TORT_REGISTRY).map(t => t.label);

  // Union of all three sources, de-duped and sorted. Registry ensures all 31
  // supported torts appear in the UI even before any leads land.
  const allTypes = [...new Set([...fromRegistry, ...fromLeads, ...fromConfigs])].sort();

  res.json({
    tort_types: allTypes,
    configs: configs.map(sanitizeRow),
  });
});

// PUT /portal-settings/:tortType
// Upserts the portal config for one tort type. Idempotent — safe to re-submit.
router.put("/:tortType", requirePermission(Permission.WORKFLOW_SETTINGS_MANAGE), async (req, res) => {
  const firmId = req.user!.firm_id;
  const tortType = String(req.params["tortType"]).trim();

  if (!tortType || tortType.length > 100) {
    badRequest(res, "Invalid tort_type");
    return;
  }

  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid request body");
    return;
  }

  const { fasten_api_key, ...data } = parsed.data;

  // Hash only if a new key was explicitly provided; otherwise leave existing.
  const keyPatch: Partial<{ fasten_api_key_hash: string | null }> = {};
  if (fasten_api_key !== undefined && fasten_api_key !== null) {
    keyPatch.fasten_api_key_hash = fasten_api_key.length > 0
      ? crypto.createHash("sha256").update(fasten_api_key).digest("hex")
      : null;
  }

  const now = new Date();

  const [row] = await db
    .insert(firmPortalConfigsTable)
    .values({
      firm_id: firmId,
      tort_type: tortType,
      ...data,
      ...keyPatch,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [firmPortalConfigsTable.firm_id, firmPortalConfigsTable.tort_type],
      set: { ...data, ...keyPatch, updated_at: now },
    })
    .returning();

  res.json(sanitizeRow(row));
});

export default router;
