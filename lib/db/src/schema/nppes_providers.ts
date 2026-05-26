import {
  pgTable,
  text,
  char,
  boolean,
  date,
  jsonb,
  index,
  timestamp,
} from "drizzle-orm/pg-core";

export const nppsProvidersTable = pgTable(
  "nppes_providers",
  {
    npi: text("npi").primaryKey(),

    // 1 = individual, 2 = organization
    entity_type: char("entity_type", { length: 1 }),

    // Organization fields (entity_type = 2)
    org_name: text("org_name"),
    other_org_name: text("other_org_name"),
    other_org_name_type: text("other_org_name_type"),
    parent_org_name: text("parent_org_name"),
    parent_org_tin: text("parent_org_tin"),
    is_org_subpart: boolean("is_org_subpart"),

    // Individual provider fields (entity_type = 1)
    last_name: text("last_name"),
    first_name: text("first_name"),
    middle_name: text("middle_name"),
    name_prefix: text("name_prefix"),
    name_suffix: text("name_suffix"),
    credential: text("credential"),
    sex: char("sex", { length: 1 }),
    sole_proprietor: boolean("sole_proprietor"),

    // Other name (alias / doing-business-as)
    other_last_name: text("other_last_name"),
    other_first_name: text("other_first_name"),
    other_middle_name: text("other_middle_name"),
    other_name_prefix: text("other_name_prefix"),
    other_name_suffix: text("other_name_suffix"),
    other_credential: text("other_credential"),
    other_last_name_type: text("other_last_name_type"),

    // Mailing address
    mail_line1: text("mail_line1"),
    mail_line2: text("mail_line2"),
    mail_city: text("mail_city"),
    mail_state: text("mail_state"),
    mail_zip: text("mail_zip"),
    mail_country: text("mail_country"),
    mail_phone: text("mail_phone"),
    mail_fax: text("mail_fax"),

    // Practice location address
    practice_line1: text("practice_line1"),
    practice_line2: text("practice_line2"),
    practice_city: text("practice_city"),
    practice_state: text("practice_state"),
    practice_zip: text("practice_zip"),
    practice_country: text("practice_country"),
    practice_phone: text("practice_phone"),
    practice_fax: text("practice_fax"),

    // Dates
    enumeration_date: date("enumeration_date"),
    last_update_date: date("last_update_date"),
    deactivation_reason: text("deactivation_reason"),
    deactivation_date: date("deactivation_date"),
    reactivation_date: date("reactivation_date"),
    certification_date: date("certification_date"),

    // Authorized official (for organizations)
    auth_last_name: text("auth_last_name"),
    auth_first_name: text("auth_first_name"),
    auth_middle_name: text("auth_middle_name"),
    auth_title: text("auth_title"),
    auth_phone: text("auth_phone"),
    auth_name_prefix: text("auth_name_prefix"),
    auth_name_suffix: text("auth_name_suffix"),
    auth_credential: text("auth_credential"),

    // Taxonomy codes as JSONB array
    // Each element: { code, license, state, primary, group }
    taxonomies: jsonb("taxonomies"),

    // Computed display name for fast search (populated on import)
    display_name: text("display_name"),

    imported_at: timestamp("imported_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("nppes_last_name_idx").on(t.last_name),
    index("nppes_org_name_idx").on(t.org_name),
    index("nppes_practice_state_idx").on(t.practice_state),
    index("nppes_mail_state_idx").on(t.mail_state),
    index("nppes_practice_fax_idx").on(t.practice_fax),
    index("nppes_mail_fax_idx").on(t.mail_fax),
    index("nppes_deactivation_idx").on(t.deactivation_date),
    index("nppes_display_name_idx").on(t.display_name),
  ],
);

export type NppesProvider = typeof nppsProvidersTable.$inferSelect;
export type NppesProviderInsert = typeof nppsProvidersTable.$inferInsert;
