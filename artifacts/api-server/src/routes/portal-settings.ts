import { Router } from "express";
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
});

function sanitizeRow(row: typeof firmPortalConfigsTable.$inferSelect) {
  return row;
}

// GET /portal-settings
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

  const allTypes = [...new Set([...fromRegistry, ...fromLeads, ...fromConfigs])].sort();

  res.json({
    tort_types: allTypes,
    configs: configs.map(sanitizeRow),
  });
});

// PUT /portal-settings/:tortType
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

  const now = new Date();

  const [row] = await db
    .insert(firmPortalConfigsTable)
    .values({
      firm_id: firmId,
      tort_type: tortType,
      ...parsed.data,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [firmPortalConfigsTable.firm_id, firmPortalConfigsTable.tort_type],
      set: { ...parsed.data, updated_at: now },
    })
    .returning();

  res.json(sanitizeRow(row));
});

export default router;
