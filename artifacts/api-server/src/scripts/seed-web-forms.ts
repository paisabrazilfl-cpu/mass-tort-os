/**
 * Seed default web_form_config rows into form_configurations for every
 * tort in TORT_REGISTRY. Idempotent — only writes when web_form_config IS
 * NULL so admin edits are never clobbered.
 *
 * Run with: pnpm --filter @workspace/api-server exec tsx src/scripts/seed-web-forms.ts
 */
import { db, formConfigurationsTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import { buildAllDefaultWebFormConfigs } from "../lib/web-form-defaults";
import { TORT_REGISTRY } from "../lib/tort-engine";

async function main() {
  const defaults = buildAllDefaultWebFormConfigs();
  let inserted = 0;
  let skipped = 0;
  let createdRows = 0;

  for (const [tortId, config] of Object.entries(defaults)) {
    const tort = TORT_REGISTRY[tortId];
    if (!tort) continue;

    const existing = await db
      .select({
        id: formConfigurationsTable.id,
        web_form_config: formConfigurationsTable.web_form_config,
      })
      .from(formConfigurationsTable)
      .where(eq(formConfigurationsTable.id, tortId))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(formConfigurationsTable).values({
        id: tortId,
        label: tort.label,
        category: tort.category,
        valid_diagnoses: tort.valid_diagnoses,
        exposure_fields: tort.exposure_fields,
        extra_fields: tort.extra_fields,
        custom_fields: [],
        rules: tort.rules,
        rejection_conditions: tort.rejection_conditions,
        required_exposure: tort.required_exposure,
        active: true,
        web_form_config: config,
      });
      createdRows += 1;
      inserted += 1;
      continue;
    }

    if (existing[0].web_form_config === null) {
      await db
        .update(formConfigurationsTable)
        .set({ web_form_config: config, updated_at: new Date() })
        .where(
          eq(formConfigurationsTable.id, tortId),
        );
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  // Sanity belt-and-braces: any remaining null rows for a tort that exists
  // in TORT_REGISTRY should be filled — guards against partial failures
  // mid-loop.
  const stillNull = await db
    .select({ id: formConfigurationsTable.id })
    .from(formConfigurationsTable)
    .where(isNull(formConfigurationsTable.web_form_config));
  if (stillNull.length > 0) {
    console.warn(
      `WARN: ${stillNull.length} form_configurations rows still have null web_form_config: ${stillNull.map(r => r.id).join(", ")}`,
    );
  }

  console.log(
    `Seeded web_form_config: ${inserted} populated, ${skipped} preserved (already set), ${createdRows} new form_configurations rows.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
