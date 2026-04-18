import { db } from "@workspace/db";
import { formConfigurationsTable } from "@workspace/db";
import type { CustomField, FormConfiguration } from "@workspace/db";
import { eq } from "drizzle-orm";
import { TORT_REGISTRY, TortDefinition } from "./tort-engine";
import { logger } from "./logger";

export type { CustomField } from "@workspace/db";

export interface FormConfigPublic {
  id: string;
  label: string;
  category: string;
  valid_diagnoses: string[];
  exposure_fields: string[];
  extra_fields: string[];
  custom_fields: CustomField[];
  rules: string[];
  rejection_conditions: string[];
  required_exposure: boolean;
  intro_text: string | null;
  active: boolean;
  updated_at: string;
}

let seeded = false;

export async function seedFormConfigurations(): Promise<void> {
  if (seeded) return;
  try {
    const existing = await db.select().from(formConfigurationsTable);
    const existingById = new Map(existing.map(r => [r.id, r]));

    let inserted = 0;
    let refreshed = 0;
    for (const [id, def] of Object.entries(TORT_REGISTRY) as [string, TortDefinition][]) {
      const row = existingById.get(id);
      if (!row) {
        await db.insert(formConfigurationsTable).values({
          id,
          label: def.label,
          category: def.category,
          valid_diagnoses: def.valid_diagnoses,
          exposure_fields: def.exposure_fields,
          extra_fields: def.extra_fields,
          custom_fields: [] as CustomField[],
          rules: def.rules,
          rejection_conditions: def.rejection_conditions,
          required_exposure: def.required_exposure,
          active: true,
        });
        inserted++;
      } else if (row.updated_by === null) {
        // Row has never been hand-edited via the admin UI. Refresh registry-managed
        // fields so 2026/MDL updates to TORT_REGISTRY flow through automatically.
        // Custom fields and intro_text are user-curated and never overwritten.
        await db
          .update(formConfigurationsTable)
          .set({
            label: def.label,
            category: def.category,
            valid_diagnoses: def.valid_diagnoses,
            exposure_fields: def.exposure_fields,
            extra_fields: def.extra_fields,
            rules: def.rules,
            rejection_conditions: def.rejection_conditions,
            required_exposure: def.required_exposure,
            updated_at: new Date(),
          })
          .where(eq(formConfigurationsTable.id, id));
        refreshed++;
      }
    }
    if (inserted > 0 || refreshed > 0) {
      logger.info(`Form config seed: inserted=${inserted}, refreshed=${refreshed}`);
    }
    seeded = true;
  } catch (e) {
    logger.error({ err: e }, "Failed to seed form configurations");
  }
}

function toPublic(row: FormConfiguration): FormConfigPublic {
  return {
    id: row.id,
    label: row.label,
    category: row.category,
    valid_diagnoses: row.valid_diagnoses ?? [],
    exposure_fields: row.exposure_fields ?? [],
    extra_fields: row.extra_fields ?? [],
    custom_fields: row.custom_fields ?? [],
    rules: row.rules ?? [],
    rejection_conditions: row.rejection_conditions ?? [],
    required_exposure: row.required_exposure ?? false,
    intro_text: row.intro_text ?? null,
    active: row.active ?? true,
    updated_at: row.updated_at?.toISOString?.() ?? new Date().toISOString(),
  };
}

export async function getFormConfigByIdOrLabel(value: string): Promise<FormConfigPublic | null> {
  const direct = await getFormConfig(value);
  if (direct) return direct;
  const needle = value.toLowerCase().trim();
  const all = await getAllFormConfigs();
  return all.find(c => c.id.toLowerCase() === needle || c.label.toLowerCase() === needle) ?? null;
}

export async function getAllFormConfigs(): Promise<FormConfigPublic[]> {
  await seedFormConfigurations();
  const rows = await db.select().from(formConfigurationsTable);
  return rows.map(toPublic);
}

export async function getFormConfig(tortId: string): Promise<FormConfigPublic | null> {
  await seedFormConfigurations();
  const rows = await db
    .select()
    .from(formConfigurationsTable)
    .where(eq(formConfigurationsTable.id, tortId))
    .limit(1);
  if (rows.length === 0) {
    // Fallback to in-memory registry if DB row doesn't exist (defense-in-depth).
    const def = TORT_REGISTRY[tortId];
    if (!def) return null;
    return {
      id: tortId,
      label: def.label,
      category: def.category,
      valid_diagnoses: def.valid_diagnoses,
      exposure_fields: def.exposure_fields,
      extra_fields: def.extra_fields,
      custom_fields: [],
      rules: def.rules,
      rejection_conditions: def.rejection_conditions,
      required_exposure: def.required_exposure,
      intro_text: null,
      active: true,
      updated_at: new Date().toISOString(),
    };
  }
  return toPublic(rows[0]);
}

export interface FormConfigUpdate {
  label?: string;
  category?: string;
  valid_diagnoses?: string[];
  exposure_fields?: string[];
  extra_fields?: string[];
  custom_fields?: CustomField[];
  rules?: string[];
  rejection_conditions?: string[];
  required_exposure?: boolean;
  intro_text?: string | null;
  active?: boolean;
}

export async function updateFormConfig(
  tortId: string,
  updates: FormConfigUpdate,
  userId: number
): Promise<FormConfigPublic | null> {
  await seedFormConfigurations();
  const existing = await getFormConfig(tortId);
  if (!existing) return null;
  const patch: Record<string, unknown> = { updated_at: new Date(), updated_by: userId };
  for (const k of Object.keys(updates) as (keyof FormConfigUpdate)[]) {
    if (updates[k] !== undefined) patch[k] = updates[k];
  }
  await db
    .update(formConfigurationsTable)
    .set(patch as never)
    .where(eq(formConfigurationsTable.id, tortId));
  // Insert if it didn't exist in DB but was registry-only.
  const after = await db
    .select()
    .from(formConfigurationsTable)
    .where(eq(formConfigurationsTable.id, tortId))
    .limit(1);
  if (after.length === 0) {
    await db.insert(formConfigurationsTable).values({
      id: tortId,
      label: updates.label ?? existing.label,
      category: updates.category ?? existing.category,
      valid_diagnoses: updates.valid_diagnoses ?? existing.valid_diagnoses,
      exposure_fields: updates.exposure_fields ?? existing.exposure_fields,
      extra_fields: updates.extra_fields ?? existing.extra_fields,
      custom_fields: updates.custom_fields ?? existing.custom_fields,
      rules: updates.rules ?? existing.rules,
      rejection_conditions: updates.rejection_conditions ?? existing.rejection_conditions,
      required_exposure: updates.required_exposure ?? existing.required_exposure,
      intro_text: updates.intro_text ?? existing.intro_text,
      active: updates.active ?? existing.active,
      updated_by: userId,
    });
  }
  return getFormConfig(tortId);
}

export async function addCustomField(
  tortId: string,
  field: CustomField,
  userId: number
): Promise<FormConfigPublic | null> {
  const cfg = await getFormConfig(tortId);
  if (!cfg) return null;
  if (cfg.custom_fields.some(f => f.key === field.key)) {
    throw new Error(`Field with key "${field.key}" already exists`);
  }
  return updateFormConfig(tortId, { custom_fields: [...cfg.custom_fields, field] }, userId);
}

export async function removeCustomField(
  tortId: string,
  key: string,
  userId: number
): Promise<FormConfigPublic | null> {
  const cfg = await getFormConfig(tortId);
  if (!cfg) return null;
  return updateFormConfig(
    tortId,
    { custom_fields: cfg.custom_fields.filter(f => f.key !== key) },
    userId
  );
}
