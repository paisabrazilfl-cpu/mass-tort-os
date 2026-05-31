import { db } from "@workspace/db";
import { formConfigurationsTable } from "@workspace/db";
import type {
  CustomField,
  FormConfiguration,
  WebFormConfig,
  WebFormField,
  EligibilityRule,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { TORT_REGISTRY, TortDefinition } from "./tort-engine";
import {
  getComprehensiveTortForm,
  buildCanonicalWebFormConfig,
  CANONICAL_CATEGORIES,
  CANONICAL_BASE_FIELD_KEYS,
  CANONICAL_BASE_RULE_IDS,
  type CanonicalCategory,
} from "./comprehensive-tort-forms";
import { logger } from "./logger";

export type { CustomField } from "@workspace/db";
export { CANONICAL_CATEGORIES, type CanonicalCategory } from "./comprehensive-tort-forms";

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
  avg_settlement_low: number | null;
  avg_settlement_high: number | null;
  mdl_status: string | null;
  sol_months: number | null;
  web_form_config: WebFormConfig | null;
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
    let webFormsFilled = 0;
    let customFieldsFilled = 0;
    for (const [id, def] of Object.entries(TORT_REGISTRY) as [string, TortDefinition][]) {
      const row = existingById.get(id);
      const comp = getComprehensiveTortForm(id);
      const mergedRules = comp ? comp.rules : def.rules;
      const mergedExtraFields = comp ? comp.extra_fields : def.extra_fields;

      if (!row) {
        await db.insert(formConfigurationsTable).values({
          id,
          label: def.label,
          category: def.category,
          valid_diagnoses: def.valid_diagnoses,
          exposure_fields: def.exposure_fields,
          extra_fields: mergedExtraFields,
          custom_fields: (comp?.custom_fields ?? []) as CustomField[],
          rules: mergedRules,
          rejection_conditions: def.rejection_conditions,
          required_exposure: def.required_exposure,
          intro_text: comp?.intro_text ?? null,
          active: true,
          web_form_config: comp?.web_form_config ?? null,
        });
        if (comp?.web_form_config) webFormsFilled++;
        inserted++;
      } else if (row.updated_by === null) {
        // Row has never been hand-edited via the admin UI. Refresh registry-managed
        // fields so 2026/MDL updates to TORT_REGISTRY flow through automatically.
        const patch: Record<string, unknown> = {
          label: def.label,
          category: def.category,
          valid_diagnoses: def.valid_diagnoses,
          exposure_fields: def.exposure_fields,
          extra_fields: mergedExtraFields,
          rules: mergedRules,
          rejection_conditions: def.rejection_conditions,
          required_exposure: def.required_exposure,
          updated_at: new Date(),
        };
        if (comp) {
          if (!row.web_form_config) {
            patch["web_form_config"] = comp.web_form_config;
            webFormsFilled++;
          }
          if (!row.custom_fields || (row.custom_fields as CustomField[]).length === 0) {
            patch["custom_fields"] = comp.custom_fields;
            customFieldsFilled++;
          }
          if (!row.intro_text) {
            patch["intro_text"] = comp.intro_text;
          }
        }
        await db
          .update(formConfigurationsTable)
          .set(patch as never)
          .where(eq(formConfigurationsTable.id, id));
        refreshed++;
      } else {
        // Admin-edited row. Only fill web_form_config if it's still null —
        // never overwrite admin-edited fields.
        if (comp && !row.web_form_config) {
          await db
            .update(formConfigurationsTable)
            .set({ web_form_config: comp.web_form_config, updated_at: new Date() })
            .where(eq(formConfigurationsTable.id, id));
          webFormsFilled++;
        }
      }
    }
    if (inserted > 0 || refreshed > 0 || webFormsFilled > 0) {
      logger.info(`Form config seed: inserted=${inserted}, refreshed=${refreshed}, webFormsFilled=${webFormsFilled}, customFieldsFilled=${customFieldsFilled}`);
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
    avg_settlement_low: row.avg_settlement_low ?? null,
    avg_settlement_high: row.avg_settlement_high ?? null,
    mdl_status: row.mdl_status ?? null,
    sol_months: row.sol_months ?? null,
    web_form_config: row.web_form_config ?? null,
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
    const comp = getComprehensiveTortForm(tortId);
    return {
      id: tortId,
      label: def.label,
      category: def.category,
      valid_diagnoses: def.valid_diagnoses,
      exposure_fields: def.exposure_fields,
      extra_fields: comp?.extra_fields ?? def.extra_fields,
      custom_fields: comp?.custom_fields ?? [],
      rules: comp?.rules ?? def.rules,
      rejection_conditions: def.rejection_conditions,
      required_exposure: def.required_exposure,
      intro_text: comp?.intro_text ?? null,
      active: true,
      avg_settlement_low: null,
      avg_settlement_high: null,
      mdl_status: null,
      sol_months: null,
      updated_at: new Date().toISOString(),
      web_form_config: comp?.web_form_config ?? null,
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
  avg_settlement_low?: number | null;
  avg_settlement_high?: number | null;
  mdl_status?: string | null;
  sol_months?: number | null;
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

// ─────────────────────────────────────────────────────────────────────────
// Site Maker — create brand-new public tort sites from canonical params.
// A "site" is a form_configurations row whose id IS its public URL slug.
// ─────────────────────────────────────────────────────────────────────────

const RESERVED_SLUGS = new Set([
  "api", "admin", "intake", "c", "sitemap", "robots", "assets", "static",
  "preview", "embed", "submit", "new", "edit", "list", "all", "health",
  "healthz", "login", "logout", "auth", "www",
]);

/** Normalize an arbitrary display name into a safe kebab-case URL slug. */
export function toKebabSlug(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
}

export function isCanonicalCategory(value: string): value is CanonicalCategory {
  return (CANONICAL_CATEGORIES as readonly string[]).includes(value);
}

/** True if a form_configurations row already uses this slug/id. */
export async function slugExists(slug: string): Promise<boolean> {
  const rows = await db
    .select({ id: formConfigurationsTable.id })
    .from(formConfigurationsTable)
    .where(eq(formConfigurationsTable.id, slug))
    .limit(1);
  if (rows.length > 0) return true;
  // Also collides with a built-in registry tort id.
  return Boolean(TORT_REGISTRY[slug]);
}

/**
 * Pick a unique, non-reserved slug derived from a base string. Appends a
 * numeric suffix on collision (slug-2, slug-3, …).
 */
export async function resolveUniqueSlug(base: string): Promise<string> {
  let root = toKebabSlug(base);
  if (!root) root = "site";
  if (RESERVED_SLUGS.has(root)) root = `${root}-tort`;
  let candidate = root;
  let n = 2;
  // Bounded loop — never spin forever on a pathological dataset.
  while (await slugExists(candidate)) {
    candidate = `${root}-${n}`;
    n += 1;
    if (n > 999) {
      candidate = `${root}-${Date.now()}`;
      break;
    }
  }
  return candidate;
}

export interface CreateSiteInput {
  /** Public-facing tort display name, e.g. "Roundup Weed Killer". */
  label: string;
  /** Canonical category. */
  category: CanonicalCategory;
  /** Optional explicit slug; otherwise derived from label. */
  slug?: string;
  /** Hero headline; defaults to label. */
  headline?: string;
  /** Hero sub-headline. */
  subhead?: string;
  /** Intro text shown above the form. */
  introText?: string | null;
  /**
   * Accepted tort-specific custom fields from the AI scaffold (the tri-state
   * proposal). The canonical locked spine is added automatically by
   * buildCanonicalWebFormConfig and cannot be overridden here.
   */
  customFields?: WebFormField[];
  /** Accepted tort-specific eligibility rules from the AI scaffold. */
  eligibilityRules?: EligibilityRule[];
  /** Decision-engine hints (optional). */
  avg_settlement_low?: number | null;
  avg_settlement_high?: number | null;
  mdl_status?: string | null;
  sol_months?: number | null;
}

/**
 * Create a brand-new public tort site. Builds a compliance-LOCKED
 * web_form_config (canonical spine + accepted tort-specific extras), inserts
 * a form_configurations row keyed by slug, and stamps updated_by so the
 * seeder treats it as hand-authored and never clobbers it.
 *
 * Throws on slug collision or non-canonical category — callers (routes)
 * translate these into 4xx responses.
 */
export async function createSite(
  input: CreateSiteInput,
  userId: number,
): Promise<FormConfigPublic> {
  await seedFormConfigurations();

  const label = input.label.trim();
  if (!label) throw new Error("label is required");
  if (!isCanonicalCategory(input.category)) {
    throw new Error(`category must be one of: ${CANONICAL_CATEGORIES.join(", ")}`);
  }

  const slug = input.slug ? toKebabSlug(input.slug) : toKebabSlug(label);
  if (!slug) throw new Error("Could not derive a valid slug from the label");
  if (RESERVED_SLUGS.has(slug)) throw new Error(`"${slug}" is a reserved slug`);
  if (await slugExists(slug)) throw new Error(`Slug "${slug}" already exists`);

  const headline = (input.headline ?? label).trim();
  const subhead = (input.subhead ?? `See if you may qualify for a ${label} claim.`).trim();

  const eligibilityExtra = (input.customFields ?? []).filter(f => f.section === "eligibility");
  const storyExtra = (input.customFields ?? []).filter(f => f.section !== "eligibility");

  const webFormConfig: WebFormConfig = buildCanonicalWebFormConfig({
    headline,
    subhead,
    eligibilityExtra,
    storyExtra,
    rulesExtra: input.eligibilityRules ?? [],
  });

  // Persist accepted custom fields as legacy operator-intake custom_fields too,
  // so the operator console sees the same tort-specific questions.
  const legacyCustomFields: CustomField[] = (input.customFields ?? []).map(f => ({
    key: f.key,
    label: f.label,
    type: (["text", "email", "tel", "date", "number", "select", "textarea", "checkbox"].includes(f.type)
      ? f.type
      : "text") as CustomField["type"],
    required: f.required,
    placeholder: f.placeholder,
    helper_text: f.helper_text,
    options: f.options,
    max_length: f.max_length,
  }));

  await db.insert(formConfigurationsTable).values({
    id: slug,
    label,
    category: input.category,
    valid_diagnoses: [],
    exposure_fields: [],
    extra_fields: [],
    custom_fields: legacyCustomFields,
    rules: [],
    rejection_conditions: [],
    required_exposure: false,
    intro_text: input.introText ?? null,
    active: true,
    avg_settlement_low: input.avg_settlement_low ?? null,
    avg_settlement_high: input.avg_settlement_high ?? null,
    mdl_status: input.mdl_status ?? null,
    sol_months: input.sol_months ?? null,
    web_form_config: webFormConfig,
    updated_by: userId,
  });

  logger.info({ slug, category: input.category, userId }, "Site Maker: created new tort site");
  const created = await getFormConfig(slug);
  if (!created) throw new Error("Site created but could not be reloaded");
  return created;
}

// ─────────────────────────────────────────────────────────────────────────
// Edit lifecycle — split a stored config into its locked canonical spine vs
// the editable custom extras, and re-publish from edited params.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Split a stored web_form_config into its LOCKED canonical spine (base fields
 * + base rules) vs the admin/AI custom extras. The Site Maker wizard re-opens
 * pre-filled with ONLY the non-canonical fields/rules — the locked spine is
 * always re-attached on republish and can never be edited or dropped here.
 */
export function extractCustomParts(cfg: WebFormConfig | null): {
  headline: string;
  subhead: string;
  customFields: WebFormField[];
  eligibilityRules: EligibilityRule[];
} {
  const lockedKeys = new Set(CANONICAL_BASE_FIELD_KEYS);
  const lockedRuleIds = new Set(CANONICAL_BASE_RULE_IDS);
  return {
    headline: cfg?.intro_headline ?? "",
    subhead: cfg?.intro_subhead ?? "",
    customFields: (cfg?.fields ?? []).filter(f => !lockedKeys.has(f.key)),
    eligibilityRules: (cfg?.eligibility_rules ?? []).filter(r => !lockedRuleIds.has(r.id)),
  };
}

export interface SiteEditDetail {
  slug: string;
  label: string;
  category: string;
  intro_text: string | null;
  headline: string;
  subhead: string;
  custom_fields: WebFormField[];
  eligibility_rules: EligibilityRule[];
  active: boolean;
  web_form_enabled: boolean;
}

/** Full edit-prefill payload for one site (locked spine stripped out). */
export async function getSiteEditDetail(slug: string): Promise<SiteEditDetail | null> {
  const cfg = await getFormConfig(slug);
  if (!cfg) return null;
  const parts = extractCustomParts(cfg.web_form_config);
  return {
    slug: cfg.id,
    label: cfg.label,
    category: cfg.category,
    intro_text: cfg.intro_text,
    headline: parts.headline,
    subhead: parts.subhead,
    custom_fields: parts.customFields,
    eligibility_rules: parts.eligibilityRules,
    active: cfg.active,
    web_form_enabled: Boolean(cfg.web_form_config?.enabled),
  };
}

export interface RepublishSiteInput {
  label?: string;
  category?: CanonicalCategory;
  headline?: string;
  subhead?: string;
  introText?: string | null;
  customFields?: WebFormField[];
  eligibilityRules?: EligibilityRule[];
}

/**
 * Re-publish an existing site: rebuild the compliance-LOCKED web_form_config
 * from the canonical spine + the supplied custom extras, preserving the
 * current open/closed (enabled) state, and update the row's
 * label/category/intro_text. The locked base fields/rules are always
 * re-attached by buildCanonicalWebFormConfig and cannot be dropped here.
 *
 * Re-publishing the same slug updates the SAME row in place — it never
 * duplicates a form_configurations row.
 */
export async function republishSite(
  slug: string,
  input: RepublishSiteInput,
  userId: number,
): Promise<FormConfigPublic | null> {
  await seedFormConfigurations();
  const existing = await getFormConfig(slug);
  if (!existing) return null;
  if (input.category && !isCanonicalCategory(input.category)) {
    throw new Error(`category must be one of: ${CANONICAL_CATEGORIES.join(", ")}`);
  }

  const label = (input.label ?? existing.label).trim();
  const prevEnabled = Boolean(existing.web_form_config?.enabled);
  const prevParts = extractCustomParts(existing.web_form_config);
  const headline = (input.headline ?? (prevParts.headline || label)).trim();
  const subhead = (
    input.subhead ?? (prevParts.subhead || `See if you may qualify for a ${label} claim.`)
  ).trim();

  const customFields = input.customFields ?? prevParts.customFields;
  const eligibilityRules = input.eligibilityRules ?? prevParts.eligibilityRules;

  const eligibilityExtra = customFields.filter(f => f.section === "eligibility");
  const storyExtra = customFields.filter(f => f.section !== "eligibility");

  const rebuilt: WebFormConfig = buildCanonicalWebFormConfig({
    headline,
    subhead,
    eligibilityExtra,
    storyExtra,
    rulesExtra: eligibilityRules,
  });
  // Preserve the current open/closed state across a republish.
  rebuilt.enabled = prevEnabled;

  const legacyCustomFields: CustomField[] = customFields.map(f => ({
    key: f.key,
    label: f.label,
    type: (["text", "email", "tel", "date", "number", "select", "textarea", "checkbox"].includes(f.type)
      ? f.type
      : "text") as CustomField["type"],
    required: f.required,
    placeholder: f.placeholder,
    helper_text: f.helper_text,
    options: f.options,
    max_length: f.max_length,
  }));

  const patch: Record<string, unknown> = {
    label,
    intro_text: input.introText !== undefined ? input.introText : existing.intro_text,
    custom_fields: legacyCustomFields,
    web_form_config: rebuilt,
    updated_at: new Date(),
    updated_by: userId,
  };
  if (input.category) patch.category = input.category;

  await db
    .update(formConfigurationsTable)
    .set(patch as never)
    .where(eq(formConfigurationsTable.id, slug));

  logger.info({ slug, userId }, "Site Maker: republished site");
  return getFormConfig(slug);
}

/**
 * Soft-delete (deactivate) a site. Sets active:false so public pages 404 and
 * the form stops accepting submissions, without destroying lead history.
 */
export async function softDeleteSite(
  slug: string,
  userId: number,
): Promise<FormConfigPublic | null> {
  return updateFormConfig(slug, { active: false }, userId);
}

/** Re-activate a previously soft-deleted site. */
export async function reactivateSite(
  slug: string,
  userId: number,
): Promise<FormConfigPublic | null> {
  return updateFormConfig(slug, { active: true }, userId);
}

/** Toggle a site's enabled flag inside web_form_config (keeps the row active). */
export async function setSiteEnabled(
  slug: string,
  enabled: boolean,
  userId: number,
): Promise<FormConfigPublic | null> {
  const cfg = await getFormConfig(slug);
  if (!cfg || !cfg.web_form_config) return null;
  const next: WebFormConfig = { ...cfg.web_form_config, enabled };
  const patch: Record<string, unknown> = {
    web_form_config: next,
    updated_at: new Date(),
    updated_by: userId,
  };
  await db
    .update(formConfigurationsTable)
    .set(patch as never)
    .where(eq(formConfigurationsTable.id, slug));
  return getFormConfig(slug);
}
