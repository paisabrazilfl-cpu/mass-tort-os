/**
 * Force-sync operator-side intake configuration onto every tort row in
 * form_configurations from the canonical in-code definitions
 * (TORT_REGISTRY + comprehensive-tort-forms).
 *
 * Why this exists: the boot-time seeder (seedFormConfigurations) intentionally
 * refuses to overwrite custom_fields on rows that have been hand-edited
 * (updated_by IS NOT NULL). That left a handful of torts (afff, depo-provera,
 * hair-relaxer, roundup, suboxone, tepezza) frozen with empty/near-empty
 * intake field sets even though the canonical code carries a full
 * professional intake set for all 31 torts. This script is the deliberate,
 * authoritative apply that brings the DB up to the canonical spec.
 *
 * It OVERWRITES the operator-side columns
 *   custom_fields / extra_fields / exposure_fields / rules /
 *   valid_diagnoses / rejection_conditions / required_exposure / intro_text
 * from the canonical defs, but MERGES custom_fields BY KEY so any
 * operator-authored field that is not (yet) represented in the canonical
 * code is preserved rather than dropped (canonical wins on key collision).
 *
 * web_form_config is only filled when NULL — never clobbered.
 * updated_by is left untouched.
 *
 * Idempotent. Safe to re-run.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/sync-form-intake.ts
 */
import { db, formConfigurationsTable } from "@workspace/db";
import type { CustomField } from "@workspace/db";
import { eq } from "drizzle-orm";
import { TORT_REGISTRY, type TortDefinition } from "../lib/tort-engine";
import { getComprehensiveTortForm } from "../lib/comprehensive-tort-forms";
import { logger } from "../lib/logger";

/**
 * Merge canonical custom fields with whatever is already on the row,
 * de-duplicated by `key`. Canonical definitions take precedence on a key
 * collision; any extra operator-authored field whose key is not in the
 * canonical set is appended so it is never silently dropped.
 */
function mergeCustomFields(
  canonical: CustomField[],
  existing: CustomField[] | null | undefined,
): { merged: CustomField[]; preservedKeys: string[] } {
  const canonicalKeys = new Set(canonical.map((f) => f.key));
  const preserved = (existing ?? []).filter((f) => f && !canonicalKeys.has(f.key));
  return {
    merged: [...canonical, ...preserved],
    preservedKeys: preserved.map((f) => f.key),
  };
}

interface SyncRow {
  id: string;
  custom_fields: number;
  extra_fields: number;
  exposure_fields: number;
  rules: number;
  valid_diagnoses: number;
  preserved: string;
  action: "updated" | "inserted";
}

async function main(): Promise<void> {
  const existing = await db.select().from(formConfigurationsTable);
  const existingById = new Map(existing.map((r) => [r.id, r]));

  const report: SyncRow[] = [];

  for (const [id, def] of Object.entries(TORT_REGISTRY) as [string, TortDefinition][]) {
    const comp = getComprehensiveTortForm(id);
    if (!comp) {
      logger.warn({ tort: id }, "No comprehensive form for tort — skipping");
      continue;
    }

    const row = existingById.get(id);
    const { merged, preservedKeys } = mergeCustomFields(comp.custom_fields, row?.custom_fields);

    const canonical = {
      label: def.label,
      category: def.category,
      valid_diagnoses: def.valid_diagnoses,
      exposure_fields: def.exposure_fields,
      extra_fields: comp.extra_fields,
      custom_fields: merged,
      rules: comp.rules,
      rejection_conditions: def.rejection_conditions,
      required_exposure: def.required_exposure,
      intro_text: comp.intro_text,
    };

    if (!row) {
      await db.insert(formConfigurationsTable).values({
        id,
        ...canonical,
        active: true,
        web_form_config: comp.web_form_config,
      });
      report.push({
        id,
        custom_fields: merged.length,
        extra_fields: canonical.extra_fields.length,
        exposure_fields: canonical.exposure_fields.length,
        rules: canonical.rules.length,
        valid_diagnoses: canonical.valid_diagnoses.length,
        preserved: preservedKeys.join(", ") || "—",
        action: "inserted",
      });
      continue;
    }

    const patch: Record<string, unknown> = {
      ...canonical,
      updated_at: new Date(),
    };
    // Only backfill web_form_config when it has never been set; never clobber.
    if (!row.web_form_config) {
      patch["web_form_config"] = comp.web_form_config;
    }

    await db
      .update(formConfigurationsTable)
      .set(patch as never)
      .where(eq(formConfigurationsTable.id, id));

    report.push({
      id,
      custom_fields: merged.length,
      extra_fields: canonical.extra_fields.length,
      exposure_fields: canonical.exposure_fields.length,
      rules: canonical.rules.length,
      valid_diagnoses: canonical.valid_diagnoses.length,
      preserved: preservedKeys.join(", ") || "—",
      action: "updated",
    });
  }

  const inserted = report.filter((r) => r.action === "inserted").length;
  const updated = report.filter((r) => r.action === "updated").length;
  const withPreserved = report.filter((r) => r.preserved !== "—");

  logger.info(
    { inserted, updated, total: report.length },
    "Form intake sync complete",
  );
  for (const r of report) {
    logger.info(
      {
        tort: r.id,
        action: r.action,
        custom_fields: r.custom_fields,
        extra_fields: r.extra_fields,
        exposure_fields: r.exposure_fields,
        rules: r.rules,
        valid_diagnoses: r.valid_diagnoses,
        preserved: r.preserved,
      },
      "synced tort",
    );
  }
  if (withPreserved.length > 0) {
    logger.info(
      { torts: withPreserved.map((r) => `${r.id}:[${r.preserved}]`) },
      "Operator-authored custom fields preserved (canonical did not redefine these keys)",
    );
  }

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "Form intake sync failed");
  process.exit(1);
});
