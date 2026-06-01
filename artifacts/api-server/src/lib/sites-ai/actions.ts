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

// Build an HONEST, result-derived confirmation line from the real persisted
// execute result. We never emit a generic "done" — the operator must be able to
// see exactly what happened (real counts/identities) so a completed action can
// never be mistaken for a hallucinated one.
export function summarizeExecResult(
  kind: SitesActionProposal["kind"],
  result: Record<string, unknown>,
): string {
  const num = (k: string): number | null =>
    typeof result[k] === "number" ? (result[k] as number) : null;
  const str = (k: string): string | null =>
    typeof result[k] === "string" ? (result[k] as string) : null;

  switch (kind) {
    case "rebuild_all": {
      const scanned = num("scanned") ?? 0;
      const verified = num("verified") ?? 0;
      const rebuilt = num("rebuilt") ?? 0;
      const failed = num("failed") ?? 0;
      let line =
        `Rebuild-all complete: scanned ${scanned} site${scanned === 1 ? "" : "s"} ` +
        `(all sites, active and archived) — ${verified} verified, ${rebuilt} backfilled, ${failed} failed.`;
      const failures = Array.isArray(result["failures"])
        ? (result["failures"] as Array<{ slug?: string; reason?: string }>)
        : [];
      if (failures.length > 0) {
        line +=
          " Failures: " +
          failures
            .slice(0, 10)
            .map((f) => `${f.slug ?? "?"} (${f.reason ?? "unknown"})`)
            .join("; ");
      }
      return line;
    }
    case "seo_rebuild_all": {
      const scanned = num("scanned") ?? 0;
      const status = str("status") ?? "ok";
      const counts = (result["counts"] ?? {}) as Record<string, unknown>;
      const total = typeof counts["total"] === "number" ? (counts["total"] as number) : null;
      const dups = Array.isArray(result["duplicates"])
        ? (result["duplicates"] as unknown[]).length
        : 0;
      return (
        `SEO rebuild complete (${status}): scanned ${scanned} live site${scanned === 1 ? "" : "s"}` +
        (total != null ? `, ${total} pages in the manifest` : "") +
        (dups > 0 ? `, ${dups} duplicate URL${dups === 1 ? "" : "s"} flagged` : ", no duplicate URLs") +
        "."
      );
    }
    case "create_site": {
      const label = str("label") ?? "(unnamed)";
      const slug = str("slug") ?? "?";
      const category = str("category") ?? "?";
      return `Created site "${label}" (slug ${slug}, category ${category}).`;
    }
    case "edit_site": {
      const label = str("label") ?? "(unnamed)";
      const slug = str("slug") ?? "?";
      const category = str("category") ?? "?";
      return `Updated site "${label}" (slug ${slug}, category ${category}).`;
    }
    default:
      return "Action completed.";
  }
}

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
