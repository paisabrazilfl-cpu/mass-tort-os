/**
 * AI Observer API — read-only, additive, zero mutations.
 *
 * Designed for AI agents that need a structured, machine-readable view of the
 * CRM while performing work (cosmetic changes, audits, analysis, etc.).
 *
 * RBAC: DASHBOARD_VIEW permission — every authenticated role has this.
 * Scope: GET only. No writes, no deletes, no side effects.
 *
 * Routes:
 *   GET /api/ai-observer/snapshot   — full CRM state snapshot
 *   GET /api/ai-observer/navigation — sidebar nav structure (static)
 *   GET /api/ai-observer/pages      — all registered frontend page routes
 */

import { Router } from "express";
import {
  db,
  leadsTable,
  casesTable,
  documentsTable,
  auditLogTable,
  jobQueueTable,
  reviewQueueTable,
  formConfigurationsTable,
} from "@workspace/db";
import { sql, desc, eq } from "drizzle-orm";
import { Permission, requirePermission } from "../lib/rbac";

const router = Router();
const gate = requirePermission(Permission.DASHBOARD_VIEW);

// ── static nav structure (mirrors sidebar-nav.tsx — update both together) ────

const NAV_STRUCTURE = [
  {
    section: "Home",
    items: [
      { name: "Dashboard",   href: "/" },
      { name: "Pipeline",    href: "/pipeline" },
      { name: "Analytics",   href: "/analytics" },
      { name: "User Manual", href: "/user-manual" },
    ],
  },
  {
    section: "Leads & Cases",
    items: [
      { name: "All Leads",    href: "/leads" },
      { name: "New Lead",     href: "/leads/new" },
      { name: "Import Leads", href: "/lead-import" },
      { name: "Cases",        href: "/cases" },
      { name: "Calls",        href: "/calls" },
    ],
  },
  {
    section: "Documents",
    items: [
      { name: "All Documents", href: "/documents" },
      { name: "OCR Inbox",     href: "/ocr-inbox" },
      { name: "Doc Review",    href: "/doc-review" },
      { name: "AI Drafting",   href: "/drafting" },
      { name: "Templates",     href: "/document-templates" },
    ],
  },
  {
    section: "Operations",
    items: [
      { name: "Review Queue", href: "/review-queue" },
      { name: "Job Queue",    href: "/job-queue" },
      { name: "Paralegals",   href: "/paralegals" },
      { name: "Timeline",     href: "/timeline" },
    ],
  },
  {
    section: "Lead Gen & Research",
    items: [
      { name: "Intake Form",       href: "/form-engine" },
      { name: "Public Forms",      href: "/web-forms" },
      { name: "Form API",          href: "/forms-api" },
      { name: "Competitive Intel", href: "/competitive-intel" },
      { name: "Ads Libraries",     href: "/ads-libraries" },
      { name: "Tort News",         href: "/news" },
      { name: "Financial News",    href: "/financial-news" },
    ],
  },
  {
    section: "AI & Clinical",
    items: [
      { name: "AI Agents",       href: "/ai-agents" },
      { name: "NPI Lookup",      href: "/npi-lookup" },
      { name: "Decision Engine", href: "/decision-engine" },
      { name: "Praxis AI",       href: "/predictive" },
    ],
  },
  {
    section: "Automation",
    items: [
      { name: "Automations",  href: "/automations" },
      { name: "Self-Heal",    href: "/self-heal" },
      { name: "Webhook Log",  href: "/automation-deliveries" },
      { name: "API Setup",    href: "/n8n-setup" },
    ],
  },
  {
    section: "Settings",
    items: [
      { name: "Firm Settings",     href: "/firm-settings" },
      { name: "Team Members",      href: "/users" },
      { name: "Vendors",           href: "/vendors" },
      { name: "Buyers",            href: "/buyers" },
      { name: "Assignment Matrix", href: "/template-assignments" },
      { name: "Workflow Settings", href: "/workflow-settings" },
      { name: "Integrations",      href: "/integrations" },
      { name: "Billing",           href: "/billing" },
      { name: "Compliance",        href: "/compliance" },
      { name: "Security",          href: "/security" },
    ],
  },
  {
    section: "BOS-OMEGA",
    superAdminOnly: true,
    items: [
      { name: "Dark Room", href: "/dark-room" },
    ],
  },
] as const;

// Flat list of every frontend page href
const ALL_PAGES = NAV_STRUCTURE.flatMap((s) => s.items.map((i) => i.href));

// ── GET /api/ai-observer/navigation ──────────────────────────────────────────

router.get("/navigation", gate, (_req, res) => {
  res.json({
    sections: NAV_STRUCTURE.length,
    navigation: NAV_STRUCTURE,
  });
});

// ── GET /api/ai-observer/pages ────────────────────────────────────────────────

router.get("/pages", gate, (_req, res) => {
  res.json({
    total: ALL_PAGES.length,
    pages: ALL_PAGES,
  });
});

// ── GET /api/ai-observer/snapshot ────────────────────────────────────────────

router.get("/snapshot", gate, async (req, res) => {
  const firmId: number = (req as any).user?.firm_id;

  // Run all DB queries in parallel; each is wrapped so one failure won't
  // abort the entire snapshot — the field will be null with an error note.
  const [leadCounts, casesTotal, docsTotal, pendingJobs, reviewDepth, activeForms, recentActivity] =
    await Promise.all([
      // leads by status
      db
        .select({ status: leadsTable.status, count: sql<number>`count(*)::int` })
        .from(leadsTable)
        .where(firmId ? eq(leadsTable.firm_id, firmId) : sql`true`)
        .groupBy(leadsTable.status)
        .catch(() => null),

      // total cases
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(casesTable)
        .catch(() => null),

      // total documents
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(documentsTable)
        .catch(() => null),

      // pending jobs in the background queue
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobQueueTable)
        .where(eq(jobQueueTable.status, "pending"))
        .catch(() => null),

      // items in review queue awaiting resolution
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(reviewQueueTable)
        .where(eq(reviewQueueTable.resolution, "pending"))
        .catch(() => null),

      // active published forms
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(formConfigurationsTable)
        .where(eq(formConfigurationsTable.active, true))
        .catch(() => null),

      // last 8 audit log entries — no PII, just action + entity type + time
      db
        .select({
          action:      auditLogTable.action,
          entity_type: auditLogTable.entity_type,
          occurred_at: auditLogTable.occurred_at,
        })
        .from(auditLogTable)
        .orderBy(desc(auditLogTable.occurred_at))
        .limit(8)
        .catch(() => null),
    ]);

  // Normalise lead counts into a { [status]: count } map
  const leadsByStatus = leadCounts
    ? Object.fromEntries(leadCounts.map((r) => [r.status, r.count]))
    : null;

  res.json({
    timestamp: new Date().toISOString(),

    system: {
      db_reachable: leadCounts !== null,
      api_version:  process.env.npm_package_version ?? "unknown",
      node_version: process.version,
      env:          process.env.NODE_ENV ?? "unknown",
    },

    navigation: {
      sections:    NAV_STRUCTURE.length,
      total_pages: ALL_PAGES.length,
      structure:   NAV_STRUCTURE,
    },

    counts: {
      leads: {
        by_status: leadsByStatus,
        total:     leadCounts ? leadCounts.reduce((s, r) => s + r.count, 0) : null,
      },
      cases:        casesTotal?.[0]?.count ?? null,
      documents:    docsTotal?.[0]?.count ?? null,
      pending_jobs: pendingJobs?.[0]?.count ?? null,
      review_queue: reviewDepth?.[0]?.count ?? null,
      active_forms: activeForms?.[0]?.count ?? null,
    },

    recent_activity: recentActivity ?? [],
  });
});

export default router;
