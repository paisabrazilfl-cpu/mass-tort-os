/**
 * Dialer routes — enterprise outbound call-center module.
 *
 * Sub-systems:
 *  - Campaigns: outbound dialing campaigns with predictive/preview/power/manual modes
 *  - DNC: Do-Not-Call registry (TCPA compliance)
 *  - Scripts: call scripts for agents
 *  - Stats: live dashboard metrics
 *  - Manual call: initiate outbound call through configured voice provider
 */
import { Router } from "express";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import {
  dialerCampaignsTable,
  dialerCampaignLeadsTable,
  dialerDncTable,
  dialerScriptsTable,
  callLogsTable,
  leadsTable,
} from "@workspace/db";
import {
  eq, and, desc, asc, sql, ilike, or, inArray, count,
  gte, lte, ne,
} from "drizzle-orm";
import { requirePermission, Permission } from "../lib/rbac";
import { badRequest, notFound } from "../lib/http-errors";
import { getFirmIdForUser } from "../lib/subscription-gate";
import { logger } from "../lib/logger";
import { resolveProvider, isResolved } from "../lib/provider-router";
import { getVoiceAdapter } from "../lib/voice";

const router = Router();

async function getFirmId(userId: number): Promise<number | null> {
  if (userId <= 0) return null;
  return getFirmIdForUser(userId);
}

// ─── STATS ──────────────────────────────────────────────────────────────────

router.get(
  "/stats",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const firmId = await getFirmId(req.user!.id);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [callStats, campaignStats, dncCount] = await Promise.all([
      db
        .select({
          total: count(),
          connected: sql<number>`count(*) filter (where status = 'completed')`.mapWith(Number),
          in_progress: sql<number>`count(*) filter (where status = 'in_progress')`.mapWith(Number),
          failed: sql<number>`count(*) filter (where status = 'failed')`.mapWith(Number),
        })
        .from(callLogsTable)
        .where(
          and(
            firmId != null ? eq(callLogsTable.firm_id, firmId) : sql`true`,
            gte(callLogsTable.created_at, todayStart),
          ),
        ),
      db
        .select({
          active: sql<number>`count(*) filter (where status = 'active')`.mapWith(Number),
          paused: sql<number>`count(*) filter (where status = 'paused')`.mapWith(Number),
          total: count(),
        })
        .from(dialerCampaignsTable)
        .where(firmId != null ? eq(dialerCampaignsTable.firm_id, firmId) : sql`true`),
      db
        .select({ cnt: count() })
        .from(dialerDncTable)
        .where(firmId != null ? eq(dialerDncTable.firm_id, firmId) : sql`true`),
    ]);

    const cs = callStats[0] ?? { total: 0, connected: 0, in_progress: 0, failed: 0 };
    const camps = campaignStats[0] ?? { active: 0, paused: 0, total: 0 };

    res.json({
      today: {
        total_calls: Number(cs.total),
        connected: Number(cs.connected),
        in_progress: Number(cs.in_progress),
        failed: Number(cs.failed),
        connect_rate:
          cs.total > 0 ? Math.round((Number(cs.connected) / Number(cs.total)) * 100) : 0,
      },
      campaigns: {
        active: Number(camps.active),
        paused: Number(camps.paused),
        total: Number(camps.total),
      },
      dnc_count: Number(dncCount[0]?.cnt ?? 0),
    });
  },
);

// ─── CAMPAIGNS ───────────────────────────────────────────────────────────────

const campaignSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["predictive", "preview", "power", "manual"]).default("preview"),
  caller_id: z.string().max(32).optional(),
  script_id: z.number().int().positive().optional(),
  max_concurrent_calls: z.number().int().min(1).max(50).default(1),
  retry_attempts: z.number().int().min(0).max(10).default(3),
  retry_delay_minutes: z.number().int().min(0).max(1440).default(60),
  call_window_start: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  call_window_end: z.string().regex(/^\d{2}:\d{2}$/).default("20:00"),
  timezone: z.string().max(60).default("America/New_York"),
  notes: z.string().max(2000).optional(),
});

router.get(
  "/campaigns",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const firmId = await getFirmId(req.user!.id);
    const rows = await db
      .select()
      .from(dialerCampaignsTable)
      .where(firmId != null ? eq(dialerCampaignsTable.firm_id, firmId) : sql`true`)
      .orderBy(desc(dialerCampaignsTable.created_at));
    res.json({ campaigns: rows });
  },
);

router.post(
  "/campaigns",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const parsed = campaignSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "Invalid campaign data", parsed.error.issues);
      return;
    }
    const firmId = await getFirmId(req.user!.id);
    if (!firmId && req.user!.id > 0) {
      res.status(403).json({ code: "NO_FIRM", message: "User not linked to a firm." });
      return;
    }
    const [row] = await db
      .insert(dialerCampaignsTable)
      .values({
        ...parsed.data,
        firm_id: firmId ?? 0,
        created_by: req.user!.id,
      })
      .returning();
    logger.info({ campaignId: row.id }, "dialer campaign created");
    res.status(201).json({ campaign: row });
  },
);

router.get(
  "/campaigns/:id",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { badRequest(res, "Invalid id"); return; }
    const firmId = await getFirmId(req.user!.id);
    const [row] = await db
      .select()
      .from(dialerCampaignsTable)
      .where(
        and(
          eq(dialerCampaignsTable.id, id),
          firmId != null ? eq(dialerCampaignsTable.firm_id, firmId) : sql`true`,
        ),
      );
    if (!row) { notFound(res, "Campaign"); return; }
    res.json({ campaign: row });
  },
);

router.patch(
  "/campaigns/:id",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { badRequest(res, "Invalid id"); return; }
    const parsed = campaignSchema.partial().safeParse(req.body);
    if (!parsed.success) { badRequest(res, "Invalid data", parsed.error.issues); return; }
    const firmId = await getFirmId(req.user!.id);
    const [row] = await db
      .update(dialerCampaignsTable)
      .set({ ...parsed.data, updated_at: new Date() })
      .where(
        and(
          eq(dialerCampaignsTable.id, id),
          firmId != null ? eq(dialerCampaignsTable.firm_id, firmId) : sql`true`,
        ),
      )
      .returning();
    if (!row) { notFound(res, "Campaign"); return; }
    res.json({ campaign: row });
  },
);

router.delete(
  "/campaigns/:id",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { badRequest(res, "Invalid id"); return; }
    const firmId = await getFirmId(req.user!.id);
    const [row] = await db
      .delete(dialerCampaignsTable)
      .where(
        and(
          eq(dialerCampaignsTable.id, id),
          firmId != null ? eq(dialerCampaignsTable.firm_id, firmId) : sql`true`,
        ),
      )
      .returning({ id: dialerCampaignsTable.id });
    if (!row) { notFound(res, "Campaign"); return; }
    res.json({ deleted: true });
  },
);

router.post(
  "/campaigns/:id/start",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { badRequest(res, "Invalid id"); return; }
    const firmId = await getFirmId(req.user!.id);
    const [row] = await db
      .update(dialerCampaignsTable)
      .set({ status: "active", updated_at: new Date() })
      .where(
        and(
          eq(dialerCampaignsTable.id, id),
          firmId != null ? eq(dialerCampaignsTable.firm_id, firmId) : sql`true`,
        ),
      )
      .returning();
    if (!row) { notFound(res, "Campaign"); return; }
    logger.info({ campaignId: id }, "dialer campaign started");
    res.json({ campaign: row });
  },
);

router.post(
  "/campaigns/:id/pause",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { badRequest(res, "Invalid id"); return; }
    const firmId = await getFirmId(req.user!.id);
    const [row] = await db
      .update(dialerCampaignsTable)
      .set({ status: "paused", updated_at: new Date() })
      .where(
        and(
          eq(dialerCampaignsTable.id, id),
          firmId != null ? eq(dialerCampaignsTable.firm_id, firmId) : sql`true`,
        ),
      )
      .returning();
    if (!row) { notFound(res, "Campaign"); return; }
    res.json({ campaign: row });
  },
);

// Campaign leads management
router.get(
  "/campaigns/:id/leads",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { badRequest(res, "Invalid id"); return; }
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.page_size ?? "50"), 10)));
    const offset = (page - 1) * pageSize;

    const rows = await db
      .select({
        cl: dialerCampaignLeadsTable,
        lead_first: leadsTable.first_name,
        lead_last: leadsTable.last_name,
        lead_phone: leadsTable.phone,
      })
      .from(dialerCampaignLeadsTable)
      .leftJoin(leadsTable, eq(dialerCampaignLeadsTable.lead_id, leadsTable.id))
      .where(eq(dialerCampaignLeadsTable.campaign_id, id))
      .orderBy(asc(dialerCampaignLeadsTable.id))
      .limit(pageSize)
      .offset(offset);

    res.json({ leads: rows });
  },
);

router.post(
  "/campaigns/:id/leads",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { badRequest(res, "Invalid id"); return; }
    const parsed = z.object({ lead_ids: z.array(z.number().int().positive()).min(1).max(1000) })
      .safeParse(req.body);
    if (!parsed.success) { badRequest(res, "Invalid data", parsed.error.issues); return; }

    const { lead_ids } = parsed.data;
    const values = lead_ids.map((lid) => ({ campaign_id: id, lead_id: lid }));
    await db.insert(dialerCampaignLeadsTable).values(values).onConflictDoNothing();
    await db
      .update(dialerCampaignsTable)
      .set({ total_leads: sql`total_leads + ${lead_ids.length}`, updated_at: new Date() })
      .where(eq(dialerCampaignsTable.id, id));
    res.json({ added: lead_ids.length });
  },
);

// ─── DNC ─────────────────────────────────────────────────────────────────────

const dncSchema = z.object({
  phone_number: z.string().min(7).max(32),
  reason: z.string().max(200).optional(),
  source: z.enum(["manual", "optout", "scrub", "complaint"]).default("manual"),
  expires_at: z.coerce.date().optional(),
});

router.get(
  "/dnc",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const firmId = await getFirmId(req.user!.id);
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.page_size ?? "50"), 10)));
    const search = String(req.query.search ?? "").trim();
    const offset = (page - 1) * pageSize;

    const conditions = [firmId != null ? eq(dialerDncTable.firm_id, firmId) : sql`true`];
    if (search) conditions.push(ilike(dialerDncTable.phone_number, `%${search}%`));

    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(dialerDncTable)
        .where(and(...conditions))
        .orderBy(desc(dialerDncTable.created_at))
        .limit(pageSize)
        .offset(offset),
      db
        .select({ total: count() })
        .from(dialerDncTable)
        .where(and(...conditions)),
    ]);

    res.json({ dnc: rows, total: Number(total), page, page_size: pageSize });
  },
);

router.post(
  "/dnc",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const parsed = dncSchema.safeParse(req.body);
    if (!parsed.success) { badRequest(res, "Invalid data", parsed.error.issues); return; }
    const firmId = await getFirmId(req.user!.id);
    if (!firmId && req.user!.id > 0) {
      res.status(403).json({ code: "NO_FIRM", message: "User not linked to a firm." });
      return;
    }
    const [row] = await db
      .insert(dialerDncTable)
      .values({ ...parsed.data, firm_id: firmId ?? 0, added_by: req.user!.id })
      .onConflictDoNothing()
      .returning();
    res.status(201).json({ entry: row ?? null, already_exists: !row });
  },
);

router.post(
  "/dnc/bulk",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const parsed = z.object({
      numbers: z.array(z.string().min(7).max(32)).min(1).max(5000),
      reason: z.string().max(200).optional(),
      source: z.enum(["manual", "optout", "scrub", "complaint"]).default("scrub"),
    }).safeParse(req.body);
    if (!parsed.success) { badRequest(res, "Invalid data", parsed.error.issues); return; }
    const firmId = await getFirmId(req.user!.id);
    if (!firmId && req.user!.id > 0) {
      res.status(403).json({ code: "NO_FIRM", message: "User not linked to a firm." });
      return;
    }
    const values = parsed.data.numbers.map((n) => ({
      firm_id: firmId ?? 0,
      phone_number: n,
      reason: parsed.data.reason,
      source: parsed.data.source,
      added_by: req.user!.id,
    }));
    await db.insert(dialerDncTable).values(values).onConflictDoNothing();
    res.json({ imported: parsed.data.numbers.length });
  },
);

router.post(
  "/dnc/check",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const parsed = z.object({ phone_number: z.string().min(7).max(32) }).safeParse(req.body);
    if (!parsed.success) { badRequest(res, "Invalid data"); return; }
    const firmId = await getFirmId(req.user!.id);
    const [row] = await db
      .select()
      .from(dialerDncTable)
      .where(
        and(
          firmId != null ? eq(dialerDncTable.firm_id, firmId) : sql`true`,
          eq(dialerDncTable.phone_number, parsed.data.phone_number),
        ),
      )
      .limit(1);
    res.json({ on_dnc: !!row, entry: row ?? null });
  },
);

router.delete(
  "/dnc/:id",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { badRequest(res, "Invalid id"); return; }
    const firmId = await getFirmId(req.user!.id);
    const [row] = await db
      .delete(dialerDncTable)
      .where(
        and(
          eq(dialerDncTable.id, id),
          firmId != null ? eq(dialerDncTable.firm_id, firmId) : sql`true`,
        ),
      )
      .returning({ id: dialerDncTable.id });
    if (!row) { notFound(res, "DNC entry"); return; }
    res.json({ deleted: true });
  },
);

// ─── SCRIPTS ─────────────────────────────────────────────────────────────────

const scriptSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.string().max(80).optional(),
  content: z.object({
    sections: z.array(z.object({
      title: z.string(),
      text: z.string(),
      type: z.enum(["opening", "discovery", "pitch", "objection", "close", "custom"]),
    })),
  }).default({ sections: [] }),
  is_active: z.boolean().default(true),
});

router.get(
  "/scripts",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const firmId = await getFirmId(req.user!.id);
    const rows = await db
      .select()
      .from(dialerScriptsTable)
      .where(
        and(
          firmId != null ? eq(dialerScriptsTable.firm_id, firmId) : sql`true`,
        ),
      )
      .orderBy(desc(dialerScriptsTable.updated_at));
    res.json({ scripts: rows });
  },
);

router.post(
  "/scripts",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const parsed = scriptSchema.safeParse(req.body);
    if (!parsed.success) { badRequest(res, "Invalid data", parsed.error.issues); return; }
    const firmId = await getFirmId(req.user!.id);
    if (!firmId && req.user!.id > 0) {
      res.status(403).json({ code: "NO_FIRM", message: "User not linked to a firm." });
      return;
    }
    const [row] = await db
      .insert(dialerScriptsTable)
      .values({ ...parsed.data, firm_id: firmId ?? 0, created_by: req.user!.id })
      .returning();
    res.status(201).json({ script: row });
  },
);

router.get(
  "/scripts/:id",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { badRequest(res, "Invalid id"); return; }
    const firmId = await getFirmId(req.user!.id);
    const [row] = await db
      .select()
      .from(dialerScriptsTable)
      .where(
        and(
          eq(dialerScriptsTable.id, id),
          firmId != null ? eq(dialerScriptsTable.firm_id, firmId) : sql`true`,
        ),
      );
    if (!row) { notFound(res, "Script"); return; }
    res.json({ script: row });
  },
);

router.patch(
  "/scripts/:id",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { badRequest(res, "Invalid id"); return; }
    const parsed = scriptSchema.partial().safeParse(req.body);
    if (!parsed.success) { badRequest(res, "Invalid data", parsed.error.issues); return; }
    const firmId = await getFirmId(req.user!.id);
    const [row] = await db
      .update(dialerScriptsTable)
      .set({ ...parsed.data, updated_at: new Date() })
      .where(
        and(
          eq(dialerScriptsTable.id, id),
          firmId != null ? eq(dialerScriptsTable.firm_id, firmId) : sql`true`,
        ),
      )
      .returning();
    if (!row) { notFound(res, "Script"); return; }
    res.json({ script: row });
  },
);

router.delete(
  "/scripts/:id",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { badRequest(res, "Invalid id"); return; }
    const firmId = await getFirmId(req.user!.id);
    const [row] = await db
      .delete(dialerScriptsTable)
      .where(
        and(
          eq(dialerScriptsTable.id, id),
          firmId != null ? eq(dialerScriptsTable.firm_id, firmId) : sql`true`,
        ),
      )
      .returning({ id: dialerScriptsTable.id });
    if (!row) { notFound(res, "Script"); return; }
    res.json({ deleted: true });
  },
);

// ─── MANUAL CALL ─────────────────────────────────────────────────────────────

router.post(
  "/call",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const parsed = z.object({
      to_number: z.string().min(7).max(32),
      lead_id: z.number().int().positive().optional(),
      campaign_id: z.number().int().positive().optional(),
      caller_id: z.string().max(32).optional(),
    }).safeParse(req.body);
    if (!parsed.success) { badRequest(res, "Invalid data", parsed.error.issues); return; }

    const firmId = await getFirmId(req.user!.id);

    // DNC guard — refuse to call numbers on the DNC list
    const [dncCheck] = await db
      .select()
      .from(dialerDncTable)
      .where(
        and(
          firmId != null ? eq(dialerDncTable.firm_id, firmId) : sql`true`,
          eq(dialerDncTable.phone_number, parsed.data.to_number),
        ),
      )
      .limit(1);

    if (dncCheck) {
      res.status(422).json({
        code: "DNC_BLOCKED",
        message: `${parsed.data.to_number} is on the DNC list and cannot be dialed.`,
      });
      return;
    }

    // Resolve the configured voice provider (voice has no per-buyer override)
    const resolved = await resolveProvider("voice");
    const hasProvider = isResolved(resolved);

    // Log the call attempt regardless of provider availability
    const [callLog] = await db
      .insert(callLogsTable)
      .values({
        firm_id: firmId,
        lead_id: parsed.data.lead_id,
        direction: "outbound",
        to_number: parsed.data.to_number,
        from_number: parsed.data.caller_id ?? null,
        status: "queued",
        transcript: [],
        events: [],
      })
      .returning();

    if (!hasProvider) {
      logger.warn({ callLogId: callLog.id }, "dialer: no voice provider configured — call logged but not initiated");
      res.json({
        call_log_id: callLog.id,
        status: "queued",
        provider_status: "no_provider",
        message: "Call logged. Configure a voice provider (Telnyx or Vapi) in Integrations to enable live dialing.",
      });
      return;
    }

    try {
      const adapter = getVoiceAdapter(resolved.provider);
      if (adapter && typeof (adapter as any).initiateOutbound === "function") {
        await (adapter as any).initiateOutbound(resolved.credentials, {
          to: parsed.data.to_number,
          from: parsed.data.caller_id,
          callLogId: callLog.id,
        });
      }
      await db
        .update(callLogsTable)
        .set({ status: "in_progress", updated_at: new Date() })
        .where(eq(callLogsTable.id, callLog.id));

      res.json({ call_log_id: callLog.id, status: "in_progress", provider: resolved.provider });
    } catch (err) {
      logger.error({ err, callLogId: callLog.id }, "dialer: outbound call initiation failed");
      await db
        .update(callLogsTable)
        .set({ status: "failed", error: String((err as Error).message), updated_at: new Date() })
        .where(eq(callLogsTable.id, callLog.id));
      res.status(502).json({ code: "PROVIDER_ERROR", message: "Voice provider failed to initiate the call.", call_log_id: callLog.id });
    }
  },
);

// ─── RECORDINGS ──────────────────────────────────────────────────────────────

router.get(
  "/recordings",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const firmId = await getFirmId(req.user!.id);
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.page_size ?? "25"), 10)));
    const offset = (page - 1) * pageSize;

    const rows = await db
      .select()
      .from(callLogsTable)
      .where(
        and(
          firmId != null ? eq(callLogsTable.firm_id, firmId) : sql`true`,
          sql`recording_url is not null`,
        ),
      )
      .orderBy(desc(callLogsTable.created_at))
      .limit(pageSize)
      .offset(offset);

    res.json({ recordings: rows, page, page_size: pageSize });
  },
);

// ─── REPORTS ─────────────────────────────────────────────────────────────────

router.get(
  "/reports",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const firmId = await getFirmId(req.user!.id);
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? "30"), 10)));
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [byStatus, byDay, avgDuration] = await Promise.all([
      db
        .select({
          status: callLogsTable.status,
          count: count(),
        })
        .from(callLogsTable)
        .where(
          and(
            firmId != null ? eq(callLogsTable.firm_id, firmId) : sql`true`,
            gte(callLogsTable.created_at, since),
          ),
        )
        .groupBy(callLogsTable.status),
      db
        .select({
          day: sql<string>`date_trunc('day', created_at)::text`,
          count: count(),
          connected: sql<number>`count(*) filter (where status = 'completed')`.mapWith(Number),
        })
        .from(callLogsTable)
        .where(
          and(
            firmId != null ? eq(callLogsTable.firm_id, firmId) : sql`true`,
            gte(callLogsTable.created_at, since),
          ),
        )
        .groupBy(sql`date_trunc('day', created_at)`)
        .orderBy(asc(sql`date_trunc('day', created_at)`)),
      db
        .select({
          avg_seconds: sql<number>`round(avg(duration_seconds))`.mapWith(Number),
        })
        .from(callLogsTable)
        .where(
          and(
            firmId != null ? eq(callLogsTable.firm_id, firmId) : sql`true`,
            gte(callLogsTable.created_at, since),
            sql`duration_seconds is not null`,
          ),
        ),
    ]);

    res.json({
      period_days: days,
      by_status: byStatus,
      by_day: byDay,
      avg_duration_seconds: Number(avgDuration[0]?.avg_seconds ?? 0),
    });
  },
);

// ─── VAPI CONFIG (for Web SDK) ───────────────────────────────────────────────

router.get(
  "/vapi-config",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const resolved = await resolveProvider("voice");

    if (!isResolved(resolved) || resolved.provider !== "vapi") {
      res.json({ configured: false, public_key: null, assistants: [] });
      return;
    }

    const creds = resolved.credentials as Record<string, unknown>;
    const publicKey = typeof creds.public_key === "string" ? creds.public_key.trim() || null : null;

    const adapter = getVoiceAdapter("vapi");
    if (!adapter) {
      res.json({ configured: true, public_key: publicKey, assistants: [] });
      return;
    }
    const listResult = await adapter.listAssistants(resolved.credentials);

    res.json({
      configured: true,
      public_key: publicKey,
      assistants: listResult.ok ? listResult.assistants : [],
    });
  },
);

// ─── VAPI ASSISTANT SETUP (BitDeer Qwen3-235B as LLM) ────────────────────────

router.post(
  "/vapi-assistant",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const resolved = await resolveProvider("voice");

    if (!isResolved(resolved) || resolved.provider !== "vapi") {
      res.status(422).json({ code: "NO_VAPI", message: "Vapi is not configured as your voice provider." });
      return;
    }

    const vapiCreds = resolved.credentials as Record<string, unknown>;
    const apiKey = typeof vapiCreds.api_key === "string" ? vapiCreds.api_key.trim() : "";
    if (!apiKey) {
      res.status(422).json({ code: "NO_VAPI_KEY", message: "Vapi api_key is missing from your integration." });
      return;
    }

    const bitdeerKey = process.env["BITDEER_API_KEY"]?.trim() ?? "";
    if (!bitdeerKey) {
      res.status(422).json({ code: "NO_BITDEER_KEY", message: "BITDEER_API_KEY is not set. Add it in Integrations → AI / LLM → Bitdeer." });
      return;
    }

    const schema = z.object({
      name: z.string().default("MTOS Intake Agent"),
      voice_id: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).default("alloy"),
      system_prompt: z.string().optional(),
      first_message: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "Invalid request body");
      return;
    }

    const payload = {
      name: parsed.data.name,
      model: {
        provider: "custom-llm",
        url: "https://api-inference.bitdeer.ai/v1/chat/completions",
        model: "Qwen/Qwen3-235B-A22B",
        authorizationHeader: `Bearer ${bitdeerKey}`,
        messages: [
          {
            role: "system",
            content:
              parsed.data.system_prompt ??
              "You are a professional intake specialist for a mass tort law firm. Gather: full name, date of birth, phone, email, nature of injury or claim, timeline, and relevant product or defendant details. Be empathetic and professional. If the caller qualifies, schedule a consultation. Never provide legal advice.",
          },
        ],
      },
      voice: {
        provider: "openai",
        voiceId: parsed.data.voice_id,
      },
      transcriber: {
        provider: "deepgram",
        model: "nova-2",
        language: "en-US",
      },
      firstMessage:
        parsed.data.first_message ??
        "Thank you for calling. This is the intake line for our law firm. How can I help you today?",
      endCallFunctionEnabled: true,
      recordingEnabled: true,
    };

    let resp: Response;
    try {
      resp = await fetch("https://api.vapi.ai/assistant", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err }, "vapi: create assistant network error");
      res.status(502).json({ code: "NETWORK_ERROR", message: "Could not reach Vapi API." });
      return;
    }

    const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (!resp.ok) {
      logger.error({ status: resp.status, body: json }, "vapi: create assistant failed");
      res.status(502).json({ code: "VAPI_ERROR", message: `Vapi returned HTTP ${resp.status}`, detail: json });
      return;
    }

    logger.info({ assistantId: json.id, name: json.name }, "vapi: assistant created with BitDeer Qwen3-235B LLM");
    res.status(201).json({
      assistant_id: json.id,
      name: json.name,
      model: "Qwen/Qwen3-235B-A22B",
      voice: parsed.data.voice_id,
      assistant: json,
    });
  },
);

// ─── END ACTIVE CALL ─────────────────────────────────────────────────────────

router.put(
  "/call/:id/end",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const callId = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(callId)) {
      badRequest(res, "Invalid call ID");
      return;
    }
    const firmId = await getFirmId(req.user!.id);
    const [row] = await db
      .update(callLogsTable)
      .set({ status: "completed", updated_at: new Date() })
      .where(
        and(
          eq(callLogsTable.id, callId),
          firmId != null ? eq(callLogsTable.firm_id, firmId) : sql`true`,
        ),
      )
      .returning();

    if (!row) { notFound(res); return; }
    res.json({ call_log_id: row.id, status: "completed" });
  },
);

export default router;
