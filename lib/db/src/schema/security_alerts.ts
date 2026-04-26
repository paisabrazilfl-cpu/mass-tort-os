import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const securityAlertsTable = pgTable("security_alerts", {
  id: serial("id").primaryKey(),
  type: varchar("type", { length: 50 }).notNull(),
  severity: varchar("severity", { length: 20 }).notNull(),
  source_ip: varchar("source_ip", { length: 45 }),
  user_agent: text("user_agent"),
  request_path: text("request_path"),
  request_method: varchar("request_method", { length: 10 }),
  details: text("details").notNull(),
  payload_sample: text("payload_sample"),
  ai_analysis: text("ai_analysis"),
  status: varchar("status", { length: 20 }).notNull().default("new"),
  blocked: boolean("blocked").default(false),
  country: varchar("country", { length: 50 }),
  metadata: jsonb("metadata"),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  createdAtIdx: index("security_alerts_created_at_idx").on(t.created_at),
  severityCreatedIdx: index("security_alerts_severity_created_at_idx").on(t.severity, t.created_at),
  typeCreatedIdx: index("security_alerts_type_created_at_idx").on(t.type, t.created_at),
  statusCreatedIdx: index("security_alerts_status_created_at_idx").on(t.status, t.created_at),
}));

export const blockedIpsTable = pgTable("blocked_ips", {
  id: serial("id").primaryKey(),
  ip: varchar("ip", { length: 45 }).notNull().unique(),
  reason: text("reason").notNull(),
  blocked_until: timestamp("blocked_until"),
  auto_blocked: boolean("auto_blocked").default(true),
  alert_count: integer("alert_count").default(1),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSecurityAlertSchema = createInsertSchema(securityAlertsTable).omit({
  id: true,
  created_at: true,
});

export const insertBlockedIpSchema = createInsertSchema(blockedIpsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type SecurityAlert = typeof securityAlertsTable.$inferSelect;
export type InsertSecurityAlert = z.infer<typeof insertSecurityAlertSchema>;
export type BlockedIp = typeof blockedIpsTable.$inferSelect;
export type InsertBlockedIp = z.infer<typeof insertBlockedIpSchema>;

export const securityNotificationsTable = pgTable("security_notifications", {
  id: serial("id").primaryKey(),
  alert_id: integer("alert_id"),
  severity: varchar("severity", { length: 20 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message").notNull(),
  channel: varchar("channel", { length: 20 }).notNull().default("in_app"),
  webhook_url: text("webhook_url"),
  delivered: boolean("delivered").notNull().default(false),
  acknowledged: boolean("acknowledged").notNull().default(false),
  acknowledged_by: varchar("acknowledged_by", { length: 255 }),
  created_at: timestamp("created_at").defaultNow().notNull(),
});
