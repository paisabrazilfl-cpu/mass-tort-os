// Sites AI Chat — privileged action executor with PER-ACTION re-authorization.
//
// The chat endpoint is gated broadly (anyone who can see the Sites tab —
// FORMS_CONFIG_VIEW — may chat). But a broad gate must NEVER be enough to run a
// privileged write: a confirmed proposal is re-checked here against the caller's
// actual role/permissions before any side effect, mirroring the agent-tool
// re-authorization rule. rebuild actions require super_admin (same as the
// operator routes); create/edit require FORMS_CONFIG_MANAGE. Every executed
// action is audit-logged.

import { hasPermission, Permission, type AuthUser } from "../rbac";
import { auditLog } from "../audit";
import { createSite, republishSite } from "../form-config-service";
import type {
  CreateSiteInput,
  RepublishSiteInput,
  CanonicalCategory,
} from "../form-config-service";
import { rebuildAllSites, rebuildSeoNetwork } from "../site-rebuild";
import { logger } from "../logger";
import type { SitesActionProposal } from "@workspace/db";

export type ExecuteResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: "forbidden" | "bad_request" | "not_found" | "error"; message: string };

interface AuditMeta {
  ip_address?: string;
  user_agent?: string;
}

export async function executeProposal(
  user: AuthUser,
  proposal: SitesActionProposal,
  meta?: AuditMeta,
): Promise<ExecuteResult> {
  switch (proposal.kind) {
    case "rebuild_all": {
      if (user.role !== "super_admin") {
        return { ok: false, code: "forbidden", message: "Rebuild-all requires super_admin." };
      }
      const result = await rebuildAllSites(user.id);
      await auditLog(
        "site",
        "rebuild-all",
        "sites_ai.rebuild_all",
        { ...result },
        meta,
      );
      return { ok: true, result: { ...result } };
    }

    case "seo_rebuild_all": {
      if (user.role !== "super_admin") {
        return { ok: false, code: "forbidden", message: "SEO rebuild-all requires super_admin." };
      }
      const result = await rebuildSeoNetwork(user.id);
      await auditLog(
        "site",
        "seo-rebuild-all",
        "sites_ai.seo_rebuild_all",
        { ...result },
        meta,
      );
      return { ok: true, result: { ...result } };
    }

    case "create_site": {
      if (!hasPermission(user, Permission.FORMS_CONFIG_MANAGE)) {
        return { ok: false, code: "forbidden", message: "Creating a site requires forms config manage." };
      }
      const p = proposal.params as Record<string, unknown>;
      const input: CreateSiteInput = {
        label: String(p["label"] ?? ""),
        category: String(p["category"] ?? "") as CanonicalCategory,
        slug: p["slug"] != null ? String(p["slug"]) : undefined,
        headline: p["headline"] != null ? String(p["headline"]) : undefined,
        subhead: p["subhead"] != null ? String(p["subhead"]) : undefined,
        introText: p["introText"] != null ? String(p["introText"]) : undefined,
        customFields: Array.isArray(p["customFields"])
          ? (p["customFields"] as CreateSiteInput["customFields"])
          : undefined,
        eligibilityRules: Array.isArray(p["eligibilityRules"])
          ? (p["eligibilityRules"] as CreateSiteInput["eligibilityRules"])
          : undefined,
      };
      try {
        const site = await createSite(input, user.id);
        await auditLog(
          "site",
          site.id,
          "sites_ai.create_site",
          { slug: site.id, label: site.label, category: site.category },
          meta,
        );
        return { ok: true, result: { slug: site.id, label: site.label, category: site.category } };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create site";
        logger.warn({ err, label: input.label }, "sites_ai create_site failed");
        return { ok: false, code: "bad_request", message };
      }
    }

    case "edit_site": {
      if (!hasPermission(user, Permission.FORMS_CONFIG_MANAGE)) {
        return { ok: false, code: "forbidden", message: "Editing a site requires forms config manage." };
      }
      const p = proposal.params as Record<string, unknown>;
      const slug = String(p["slug"] ?? "");
      if (!slug) return { ok: false, code: "bad_request", message: "edit_site requires a slug." };
      const input: RepublishSiteInput = {
        label: p["label"] != null ? String(p["label"]) : undefined,
        category: p["category"] != null ? (String(p["category"]) as CanonicalCategory) : undefined,
        headline: p["headline"] != null ? String(p["headline"]) : undefined,
        subhead: p["subhead"] != null ? String(p["subhead"]) : undefined,
        introText: p["introText"] != null ? String(p["introText"]) : undefined,
        customFields: Array.isArray(p["customFields"])
          ? (p["customFields"] as RepublishSiteInput["customFields"])
          : undefined,
        eligibilityRules: Array.isArray(p["eligibilityRules"])
          ? (p["eligibilityRules"] as RepublishSiteInput["eligibilityRules"])
          : undefined,
      };
      try {
        const site = await republishSite(slug, input, user.id);
        if (!site) return { ok: false, code: "not_found", message: `Site "${slug}" not found.` };
        await auditLog(
          "site",
          site.id,
          "sites_ai.edit_site",
          { slug: site.id, label: site.label, category: site.category },
          meta,
        );
        return { ok: true, result: { slug: site.id, label: site.label, category: site.category } };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to edit site";
        logger.warn({ err, slug }, "sites_ai edit_site failed");
        return { ok: false, code: "bad_request", message };
      }
    }

    default: {
      return { ok: false, code: "bad_request", message: "Unknown action." };
    }
  }
}
