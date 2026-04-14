import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
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
});

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
