import {
  pgTable, serial, integer, varchar, text, jsonb,
  timestamp, boolean, index,
} from "drizzle-orm/pg-core";

export const dialerCampaignsTable = pgTable(
  "dialer_campaigns",
  {
    id: serial("id").primaryKey(),
    firm_id: integer("firm_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    type: varchar("type", { length: 20 }).notNull().default("preview"),
    caller_id: varchar("caller_id", { length: 32 }),
    script_id: integer("script_id"),
    max_concurrent_calls: integer("max_concurrent_calls").notNull().default(1),
    retry_attempts: integer("retry_attempts").notNull().default(3),
    retry_delay_minutes: integer("retry_delay_minutes").notNull().default(60),
    call_window_start: varchar("call_window_start", { length: 8 }).default("09:00"),
    call_window_end: varchar("call_window_end", { length: 8 }).default("20:00"),
    timezone: varchar("timezone", { length: 60 }).default("America/New_York"),
    total_leads: integer("total_leads").notNull().default(0),
    dialed_count: integer("dialed_count").notNull().default(0),
    connected_count: integer("connected_count").notNull().default(0),
    converted_count: integer("converted_count").notNull().default(0),
    notes: text("notes"),
    created_by: integer("created_by"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    firmIdx: index("dialer_campaigns_firm_id_idx").on(t.firm_id),
    statusIdx: index("dialer_campaigns_status_idx").on(t.status),
  }),
);

export const dialerCampaignLeadsTable = pgTable(
  "dialer_campaign_leads",
  {
    id: serial("id").primaryKey(),
    campaign_id: integer("campaign_id").notNull(),
    lead_id: integer("lead_id").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    last_called_at: timestamp("last_called_at"),
    last_call_log_id: integer("last_call_log_id"),
    disposition: varchar("disposition", { length: 50 }),
    notes: text("notes"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    campaignIdx: index("dialer_campaign_leads_campaign_id_idx").on(t.campaign_id),
    leadIdx: index("dialer_campaign_leads_lead_id_idx").on(t.lead_id),
    campaignStatusIdx: index("dialer_campaign_leads_camp_status_idx").on(t.campaign_id, t.status),
  }),
);

export const dialerDncTable = pgTable(
  "dialer_dnc",
  {
    id: serial("id").primaryKey(),
    firm_id: integer("firm_id").notNull(),
    phone_number: varchar("phone_number", { length: 32 }).notNull(),
    reason: varchar("reason", { length: 200 }),
    source: varchar("source", { length: 30 }).notNull().default("manual"),
    added_by: integer("added_by"),
    expires_at: timestamp("expires_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    firmPhoneIdx: index("dialer_dnc_firm_phone_idx").on(t.firm_id, t.phone_number),
    firmIdx: index("dialer_dnc_firm_id_idx").on(t.firm_id),
  }),
);

export const dialerScriptsTable = pgTable(
  "dialer_scripts",
  {
    id: serial("id").primaryKey(),
    firm_id: integer("firm_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    category: varchar("category", { length: 80 }),
    content: jsonb("content")
      .$type<{ sections: Array<{ title: string; text: string; type: string }> }>()
      .notNull()
      .default({ sections: [] }),
    is_active: boolean("is_active").notNull().default(true),
    created_by: integer("created_by"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    firmIdx: index("dialer_scripts_firm_id_idx").on(t.firm_id),
  }),
);

export type DialerCampaign = typeof dialerCampaignsTable.$inferSelect;
export type DialerCampaignLead = typeof dialerCampaignLeadsTable.$inferSelect;
export type DialerDnc = typeof dialerDncTable.$inferSelect;
export type DialerScript = typeof dialerScriptsTable.$inferSelect;
