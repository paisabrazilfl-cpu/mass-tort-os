import { pgTable, serial, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";
import { usersTable } from "./users";

export const competitiveIntelAdvertisersTable = pgTable("competitive_intel_advertisers", {
  id: serial("id").primaryKey(),
  firm_id: integer("firm_id").notNull().references(() => firmsTable.id),
  advertiser_id: text("advertiser_id").notNull(),
  label: text("label").notNull(),
  notes: text("notes"),
  added_by_user_id: integer("added_by_user_id").notNull().references(() => usersTable.id),
  last_fetched_at: timestamp("last_fetched_at"),
  last_ad_count: integer("last_ad_count"),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  firmIdx: index("competitive_intel_advertisers_firm_idx").on(t.firm_id, t.created_at),
  uniqPerFirm: uniqueIndex("competitive_intel_advertisers_firm_advid_uniq").on(t.firm_id, t.advertiser_id),
}));

export const competitiveIntelSnapshotsTable = pgTable("competitive_intel_snapshots", {
  id: serial("id").primaryKey(),
  advertiser_id_fk: integer("advertiser_id_fk").notNull().references(() => competitiveIntelAdvertisersTable.id, { onDelete: "cascade" }),
  raw_response: jsonb("raw_response").notNull(),
  ad_count: integer("ad_count").notNull().default(0),
  fetched_at: timestamp("fetched_at").defaultNow().notNull(),
}, (t) => ({
  advIdx: index("competitive_intel_snapshots_adv_idx").on(t.advertiser_id_fk, t.fetched_at),
}));
