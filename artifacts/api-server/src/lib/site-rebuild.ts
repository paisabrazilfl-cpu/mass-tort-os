// Reusable Site rebuild/verification routines.
//
// Extracted from routes/sites.ts so BOTH the operator route
// (POST /api/sites/rebuild-all, /api/sites/seo/rebuild-all) and the Sites AI
// chat action executor call the exact same logic. Keeping one implementation
// means the chat assistant can never drift from the audited operator path.
//
// Both functions are non-destructive: rebuild-all forces + audits the lazy
// web_form_config backfill and verifies the serviceable spine; seo-rebuild-all
// recomputes the canonical SEO manifest from the live registry.

import { getAllFormConfigs, getFormConfig } from "./form-config-service";
import { buildSeoManifest } from "./seo-pages";
import { logger } from "./logger";

export interface RebuildAllResult {
  scanned: number;
  rebuilt: number;
  verified: number;
  failed: number;
  failures: Array<{ slug: string; reason: string }>;
}

// The minimum a resolved config needs to capture and route a real lead from
// the public intake page: the four canonical contact fields, a TCPA consent
// field, and at least one eligibility rule. We intentionally do NOT require the
// latest comprehensive field set — legitimately-seeded older sites carry a
// different (but fully serviceable) field roster.
const SERVICEABLE_REQUIRED_FIELDS = ["first_name", "last_name", "email", "phone", "tcpa_consent"];

export async function rebuildAllSites(userId: number): Promise<RebuildAllResult> {
  const configs = await getAllFormConfigs();
  let rebuilt = 0;
  let verified = 0;
  const failures: Array<{ slug: string; reason: string }> = [];

  for (const c of configs) {
    const hadConfig = Boolean(c.web_form_config);
    const refreshed = await getFormConfig(c.id);
    const cfg = refreshed?.web_form_config;
    if (!cfg) {
      failures.push({ slug: c.id, reason: "web_form_config could not be resolved" });
      continue;
    }
    if (!hadConfig) rebuilt += 1;
    const fieldKeys = new Set((cfg.fields ?? []).map((f) => f.key));
    const missingFields = SERVICEABLE_REQUIRED_FIELDS.filter((k) => !fieldKeys.has(k));
    const ruleCount = (cfg.eligibility_rules ?? []).length;
    if (missingFields.length > 0 || ruleCount < 1) {
      failures.push({
        slug: c.id,
        reason:
          `serviceable spine incomplete` +
          (missingFields.length ? ` (missing fields: ${missingFields.join(", ")})` : "") +
          (ruleCount < 1 ? ` (no eligibility rules)` : ""),
      });
      continue;
    }
    verified += 1;
  }

  logger.info(
    { scanned: configs.length, rebuilt, verified, failed: failures.length, userId },
    "Site rebuild-all",
  );

  return { scanned: configs.length, rebuilt, verified, failed: failures.length, failures };
}

export interface SeoRebuildResult {
  status: "ok" | "warn";
  scanned: number;
  counts: ReturnType<typeof buildSeoManifest>["counts"];
  duplicates: ReturnType<typeof buildSeoManifest>["duplicates"];
}

export async function rebuildSeoNetwork(userId: number): Promise<SeoRebuildResult> {
  const configs = await getAllFormConfigs();
  const manifest = buildSeoManifest(configs);

  logger.info(
    {
      scanned: configs.length,
      ...manifest.counts,
      duplicates: manifest.duplicates.length,
      userId,
    },
    "SEO rebuild-all",
  );

  return {
    status: manifest.duplicates.length === 0 ? "ok" : "warn",
    scanned: configs.length,
    counts: manifest.counts,
    duplicates: manifest.duplicates,
  };
}
