import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { firmsTable } from "./firms";

// One row per (firm, tort_type) pair — controls whether the client portal is
// enabled for a given tort campaign and carries the per-tort branding.
// tort_type values match leads.tort_type exactly so portal config lookup is
// a single equality join with no translation layer.
export const firmPortalConfigsTable = pgTable(
  "firm_portal_configs",
  {
    id: serial("id").primaryKey(),

    firm_id: integer("firm_id")
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),

    // Must match leads.tort_type exactly — no FK because tort_type is a free
    // varchar on leads, not a lookup table. Enforced at the application layer.
    tort_type: varchar("tort_type", { length: 100 }).notNull(),

    // Master switch — false blocks all portal routes for this tort even if
    // the portal app is deployed. Safe to flip without a deploy.
    portal_enabled: boolean("portal_enabled").notNull().default(false),

    // Per-tort branding shown in the client portal UI.
    brand_name: varchar("brand_name", { length: 255 }),
    brand_color: varchar("brand_color", { length: 7 }),  // CSS hex, e.g. "#1a56db"
    logo_url: text("logo_url"),

    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // Each firm can have at most one config per tort.
    firmTortIdx: uniqueIndex("firm_portal_configs_firm_tort_idx").on(t.firm_id, t.tort_type),
    firmIdx: index("firm_portal_configs_firm_idx").on(t.firm_id),
    enabledIdx: index("firm_portal_configs_enabled_idx").on(t.portal_enabled),
  }),
);

export const insertFirmPortalConfigSchema = createInsertSchema(firmPortalConfigsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertFirmPortalConfig = z.infer<typeof insertFirmPortalConfigSchema>;
export type FirmPortalConfig = typeof firmPortalConfigsTable.$inferSelect;
