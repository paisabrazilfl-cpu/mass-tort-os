/**
 * System Snapshots — operator-initiated firm-scoped config dumps for
 * disaster recovery. The snapshot endpoint serialises four operational
 * config tables to JSONB; the restore endpoint upserts them back by
 * natural key. Encrypted secrets are NEVER copied — only metadata.
 *
 * Tables included in V1:
 *   • workflow_settings        per firm
 *   • integrations             per firm (credentials redacted)
 *   • automation_workflows     per firm
 *   • document_templates       global at schema layer, included because
 *                              custom templates take real operator time.
 *
 * Excluded by design:
 *   • leads, cases, documents  — case-record tables. App-level dumps
 *     don't scale; rely on Railway's Postgres point-in-time backups.
 *   • audit_log                — append-only history; should never be
 *     replayed.
 *
 * Restore semantics:
 *   • Per-table opt-in via `tables[]` query param.
 *   • Each table has a natural key the restore upserts by — see
 *     restoreOneTable() below.
 *   • If a row in the snapshot already exists in the live table, the
 *     restore UPDATES it; if it doesn't exist, INSERTs it. Existing
 *     rows that aren't in the snapshot are LEFT ALONE — this is a
 *     merge-from-snapshot, not a replace.
 *   • Dry-run mode (?dry_run=1) returns the planned per-table action
 *     counts without touching anything.
 */
import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod/v4";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  systemSnapshotsTable,
  workflowSettingsTable,
  integrationsTable,
  automationWorkflowsTable,
  documentTemplatesTable,
  pool,
} from "@workspace/db";
import { Permission, requirePermission, auditAction } from "../lib/rbac";
import { badRequest, notFound, serverError } from "../lib/http-errors";
import { requireFirmId } from "../lib/firm-scope";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";

const router = Router();

// One-time schema repair so deploys made before 0001_system_snapshots
// can pick up the table without a manual drizzle-kit migrate run.
let _patched = false;
async function ensureTable(): Promise<void> {
  if (_patched) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS system_snapshots (
      id serial PRIMARY KEY,
      firm_id integer NOT NULL REFERENCES firms(id),
      created_by_user_id integer NOT NULL REFERENCES mtos_users(id),
      name text NOT NULL,
      payload jsonb NOT NULL,
      payload_sha256 text NOT NULL,
      byte_size integer NOT NULL,
      summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      notes text,
      created_at timestamp NOT NULL DEFAULT now()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS system_snapshots_firm_created_idx ON system_snapshots(firm_id, created_at)`);
  } catch (err) {
    logger.warn({ err }, "system_snapshots schema repair partial — continuing");
  }
  _patched = true;
}

// Set of tables a caller can include / restore. Keep this and the
// dispatch in dumpOneTable / restoreOneTable in lock-step.
const SNAPSHOTTABLE = ["workflow_settings", "integrations", "automation_workflows", "document_templates"] as const;
type SnapTable = (typeof SNAPSHOTTABLE)[number];

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  notes: z.string().max(2000).optional(),
  tables: z.array(z.enum(SNAPSHOTTABLE)).default([...SNAPSHOTTABLE]),
});

const IdParam = z.object({ id: z.coerce.number().int().positive() });

const RestoreBody = z.object({
  tables: z.array(z.enum(SNAPSHOTTABLE)).default([...SNAPSHOTTABLE]),
  dry_run: z.boolean().optional().default(false),
});

// ── Per-table dump helpers ────────────────────────────────────────────────────

interface DumpResult {
  rows: unknown[];
  count: number;
}

// Strip encrypted credentials from an integrations row before snapshotting.
// We keep config.userConfig (the operator's plaintext knobs) but blank out
// config.credentials so the snapshot never carries secret material.
function redactIntegrationRow(row: Record<string, unknown>): Record<string, unknown> {
  const cfg = (row.config as Record<string, unknown> | null) ?? {};
  return {
    ...row,
    api_key_hash: null,
    config: {
      ...(cfg.userConfig !== undefined ? { userConfig: cfg.userConfig } : {}),
      credentials: {},
    },
  };
}

async function dumpOneTable(table: SnapTable, firmId: number): Promise<DumpResult> {
  switch (table) {
    case "workflow_settings": {
      const rows = await db.select().from(workflowSettingsTable).where(eq(workflowSettingsTable.firm_id, firmId));
      return { rows, count: rows.length };
    }
    case "integrations": {
      const rows = await db.select().from(integrationsTable).where(eq(integrationsTable.firm_id, firmId));
      return { rows: rows.map((r) => redactIntegrationRow(r as Record<string, unknown>)), count: rows.length };
    }
    case "automation_workflows": {
      const rows = await db.select().from(automationWorkflowsTable).where(eq(automationWorkflowsTable.firm_id, firmId));
      return { rows, count: rows.length };
    }
    case "document_templates": {
      // Templates are global at the schema layer. Operators usually want
      // them backed up alongside their workflow config. We snapshot the
      // whole table; restore upserts by name.
      const rows = await db.select().from(documentTemplatesTable);
      return { rows, count: rows.length };
    }
  }
}

// ── Per-table restore helpers ─────────────────────────────────────────────────

interface RestorePlan {
  table: SnapTable;
  to_insert: number;
  to_update: number;
  skipped: number;
}

// Pluck a small object's columns to a value-only set we can INSERT.
function pickInsert<T>(obj: T, omit: ReadonlyArray<keyof any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!omit.includes(k)) out[k] = v;
  }
  return out;
}

async function restoreOneTable(table: SnapTable, firmId: number, snapshot: { rows: unknown[] }, dryRun: boolean): Promise<RestorePlan> {
  switch (table) {
    case "workflow_settings": {
      const live = await db.select({ id: workflowSettingsTable.id, scope: workflowSettingsTable.scope })
        .from(workflowSettingsTable)
        .where(eq(workflowSettingsTable.firm_id, firmId));
      const liveByScope = new Map(live.map((r) => [r.scope, r.id]));
      let to_insert = 0, to_update = 0, skipped = 0;
      for (const r of snapshot.rows as Array<Record<string, unknown>>) {
        const scope = r.scope as string | undefined;
        if (!scope) { skipped++; continue; }
        const existing = liveByScope.get(scope);
        const payload = pickInsert(r, ["id", "created_at", "updated_at"]);
        // Always stamp firm_id from the caller's session — never trust
        // the snapshot's firm_id, which could be from a different firm
        // if an operator imports someone else's dump.
        payload.firm_id = firmId;
        payload.updated_at = new Date();
        if (existing) {
          if (!dryRun) await db.update(workflowSettingsTable).set(payload).where(eq(workflowSettingsTable.id, existing));
          to_update++;
        } else {
          if (!dryRun) await db.insert(workflowSettingsTable).values(payload as typeof workflowSettingsTable.$inferInsert);
          to_insert++;
        }
      }
      return { table, to_insert, to_update, skipped };
    }
    case "integrations": {
      const live = await db.select({ id: integrationsTable.id, provider: integrationsTable.provider })
        .from(integrationsTable)
        .where(eq(integrationsTable.firm_id, firmId));
      const liveByProv = new Map(live.map((r) => [r.provider, r.id]));
      let to_insert = 0, to_update = 0, skipped = 0;
      for (const r of snapshot.rows as Array<Record<string, unknown>>) {
        const provider = r.provider as string | undefined;
        if (!provider) { skipped++; continue; }
        const existing = liveByProv.get(provider);
        const payload = pickInsert(r, ["id", "created_at", "updated_at"]);
        payload.firm_id = firmId;
        payload.updated_at = new Date();
        if (existing) {
          // Don't blow away existing credentials on restore. Merge the
          // snapshot's metadata into the live row but keep its
          // config.credentials (operator may have re-pasted real keys
          // post-snapshot).
          const [liveRow] = await db.select().from(integrationsTable).where(eq(integrationsTable.id, existing));
          const liveCfg = (liveRow?.config as Record<string, unknown> | null) ?? {};
          const snapCfg = (payload.config as Record<string, unknown> | null) ?? {};
          payload.config = {
            userConfig: snapCfg.userConfig ?? liveCfg.userConfig,
            credentials: liveCfg.credentials ?? {},
          };
          if (!dryRun) await db.update(integrationsTable).set(payload).where(eq(integrationsTable.id, existing));
          to_update++;
        } else {
          // Brand-new integration row. credentials starts empty —
          // operator must re-paste keys via the Integrations Hub.
          if (!dryRun) await db.insert(integrationsTable).values(payload as typeof integrationsTable.$inferInsert);
          to_insert++;
        }
      }
      return { table, to_insert, to_update, skipped };
    }
    case "automation_workflows": {
      const live = await db.select({ id: automationWorkflowsTable.id, name: automationWorkflowsTable.name })
        .from(automationWorkflowsTable)
        .where(eq(automationWorkflowsTable.firm_id, firmId));
      const liveByName = new Map(live.map((r) => [r.name, r.id]));
      let to_insert = 0, to_update = 0, skipped = 0;
      for (const r of snapshot.rows as Array<Record<string, unknown>>) {
        const name = r.name as string | undefined;
        if (!name) { skipped++; continue; }
        const existing = liveByName.get(name);
        const payload = pickInsert(r, ["id", "created_at", "updated_at"]);
        payload.firm_id = firmId;
        payload.updated_at = new Date();
        if (existing) {
          if (!dryRun) await db.update(automationWorkflowsTable).set(payload).where(eq(automationWorkflowsTable.id, existing));
          to_update++;
        } else {
          if (!dryRun) await db.insert(automationWorkflowsTable).values(payload as typeof automationWorkflowsTable.$inferInsert);
          to_insert++;
        }
      }
      return { table, to_insert, to_update, skipped };
    }
    case "document_templates": {
      // Global table — keys on name. Restore is firm-agnostic; an
      // operator from firm A restoring a template the firm-B-snapshot
      // contained is a deliberate cross-firm pollination point. Safe
      // for V1 because templates have no firm_id and existing
      // operators already share them.
      const live = await db.select({ id: documentTemplatesTable.id, name: documentTemplatesTable.name }).from(documentTemplatesTable);
      const liveByName = new Map(live.map((r) => [r.name, r.id]));
      let to_insert = 0, to_update = 0, skipped = 0;
      for (const r of snapshot.rows as Array<Record<string, unknown>>) {
        const name = r.name as string | undefined;
        if (!name) { skipped++; continue; }
        const existing = liveByName.get(name);
        const payload = pickInsert(r, ["id", "created_at", "updated_at"]);
        payload.updated_at = new Date();
        if (existing) {
          if (!dryRun) await db.update(documentTemplatesTable).set(payload).where(eq(documentTemplatesTable.id, existing));
          to_update++;
        } else {
          if (!dryRun) await db.insert(documentTemplatesTable).values(payload as typeof documentTemplatesTable.$inferInsert);
          to_insert++;
        }
      }
      return { table, to_insert, to_update, skipped };
    }
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/", requirePermission(Permission.SNAPSHOT_MANAGE), async (req, res) => {
  try {
    await ensureTable();
    const firmId = requireFirmId(req);
    const rows = await db
      .select({
        id: systemSnapshotsTable.id,
        name: systemSnapshotsTable.name,
        notes: systemSnapshotsTable.notes,
        byte_size: systemSnapshotsTable.byte_size,
        summary: systemSnapshotsTable.summary,
        created_by_user_id: systemSnapshotsTable.created_by_user_id,
        created_at: systemSnapshotsTable.created_at,
      })
      .from(systemSnapshotsTable)
      .where(eq(systemSnapshotsTable.firm_id, firmId))
      .orderBy(sql`${systemSnapshotsTable.created_at} DESC`)
      .limit(100);
    res.json({ snapshots: rows });
  } catch (err: unknown) {
    logger.error({ err }, "admin/snapshots GET / failed");
    serverError(res, "Failed to list snapshots");
  }
});

router.post(
  "/",
  requirePermission(Permission.SNAPSHOT_MANAGE),
  auditAction("snapshot_created"),
  async (req, res) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) { badRequest(res, "Invalid input", parsed.error.flatten()); return; }
    try {
      await ensureTable();
      const firmId = requireFirmId(req);

      const tables: Record<string, unknown> = {};
      const summary: Record<string, number> = {};
      for (const t of parsed.data.tables) {
        const dump = await dumpOneTable(t, firmId);
        tables[t] = dump.rows;
        summary[t] = dump.count;
      }
      const payload = {
        version: 1 as const,
        created_at: new Date().toISOString(),
        firm_id: firmId,
        tables,
      };
      const json = JSON.stringify(payload);
      const sha256 = crypto.createHash("sha256").update(json).digest("hex");

      const [row] = await db.insert(systemSnapshotsTable).values({
        firm_id: firmId,
        created_by_user_id: req.user!.id,
        name: parsed.data.name,
        notes: parsed.data.notes ?? null,
        payload,
        payload_sha256: sha256,
        byte_size: Buffer.byteLength(json, "utf8"),
        summary,
      }).returning();

      res.status(201).json({
        snapshot: {
          id: row.id,
          name: row.name,
          notes: row.notes,
          byte_size: row.byte_size,
          summary: row.summary,
          payload_sha256: row.payload_sha256,
          created_at: row.created_at,
        },
      });
    } catch (err: unknown) {
      logger.error({ err }, "admin/snapshots POST / failed");
      serverError(res, "Failed to create snapshot");
    }
  },
);

router.get("/:id", requirePermission(Permission.SNAPSHOT_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) { badRequest(res, "Invalid id"); return; }
  try {
    await ensureTable();
    const firmId = requireFirmId(req);
    const [row] = await db
      .select()
      .from(systemSnapshotsTable)
      .where(and(eq(systemSnapshotsTable.id, parsed.data.id), eq(systemSnapshotsTable.firm_id, firmId)));
    if (!row) { notFound(res, "Snapshot not found"); return; }
    // If the caller wants the raw download (no UI rendering), set
    // ?download=1 — returns an attachment with the JSON payload.
    if (req.query.download === "1") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="mtos-snapshot-${row.id}-${row.payload_sha256.slice(0, 8)}.json"`);
      res.send(JSON.stringify(row.payload));
      return;
    }
    res.json({ snapshot: row });
  } catch (err: unknown) {
    logger.error({ err, id: parsed.data.id }, "admin/snapshots GET /:id failed");
    serverError(res, "Failed to load snapshot");
  }
});

router.post(
  "/:id/restore",
  requirePermission(Permission.SNAPSHOT_MANAGE),
  auditAction("snapshot_restored"),
  async (req, res) => {
    const idParse = IdParam.safeParse(req.params);
    if (!idParse.success) { badRequest(res, "Invalid id"); return; }
    const bodyParse = RestoreBody.safeParse(req.body ?? {});
    if (!bodyParse.success) { badRequest(res, "Invalid body", bodyParse.error.flatten()); return; }
    try {
      await ensureTable();
      const firmId = requireFirmId(req);
      const [row] = await db
        .select()
        .from(systemSnapshotsTable)
        .where(and(eq(systemSnapshotsTable.id, idParse.data.id), eq(systemSnapshotsTable.firm_id, firmId)));
      if (!row) { notFound(res, "Snapshot not found"); return; }

      // Tamper-resistance: recompute the payload hash and refuse to
      // apply a payload that doesn't match. The DB is the trust root,
      // but defence-in-depth here means a future bug that silently
      // corrupts a payload row can't be applied by a restore click.
      const recomputed = crypto.createHash("sha256").update(JSON.stringify(row.payload)).digest("hex");
      if (recomputed !== row.payload_sha256) {
        res.status(409).json({
          status: "error",
          code: "snapshot_corrupt",
          message: "Snapshot payload SHA-256 does not match stored hash. Refusing to restore.",
        });
        return;
      }

      const payload = row.payload as { tables: Record<string, { rows: unknown[] } | unknown[]> };
      const plans: RestorePlan[] = [];
      for (const t of bodyParse.data.tables) {
        const tableData = payload.tables?.[t];
        const rows = Array.isArray(tableData) ? tableData : (tableData as { rows?: unknown[] })?.rows ?? [];
        plans.push(await restoreOneTable(t, firmId, { rows }, bodyParse.data.dry_run));
      }

      res.json({
        snapshot_id: row.id,
        dry_run: bodyParse.data.dry_run,
        plans,
      });
    } catch (err: unknown) {
      logger.error({ err }, "admin/snapshots restore failed");
      serverError(res, "Failed to restore snapshot");
    }
  },
);

router.delete(
  "/:id",
  requirePermission(Permission.SNAPSHOT_MANAGE),
  auditAction("snapshot_deleted"),
  async (req, res) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) { badRequest(res, "Invalid id"); return; }
    try {
      await ensureTable();
      const firmId = requireFirmId(req);
      const deleted = await db
        .delete(systemSnapshotsTable)
        .where(and(eq(systemSnapshotsTable.id, parsed.data.id), eq(systemSnapshotsTable.firm_id, firmId)))
        .returning({ id: systemSnapshotsTable.id });
      if (deleted.length === 0) { notFound(res, "Snapshot not found"); return; }
      res.status(204).end();
    } catch (err: unknown) {
      logger.error({ err }, "admin/snapshots DELETE failed");
      serverError(res, "Failed to delete snapshot");
    }
  },
);

// inArray is imported above for future bulk operations; reference here so
// the import doesn't break a lint pass if no current handler uses it yet.
void inArray;

export default router;
