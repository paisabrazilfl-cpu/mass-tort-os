import {
  pgTable,
  serial,
  varchar,
  jsonb,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const auditLogTable = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  entity_type: varchar("entity_type", { length: 50 }).notNull(),
  entity_id: varchar("entity_id", { length: 100 }).notNull(),
  action: varchar("action", { length: 50 }).notNull(),
  details: jsonb("details"),
  ip_address: varchar("ip_address", { length: 45 }),
  user_agent: text("user_agent"),
  occurred_at: timestamp("occurred_at").defaultNow().notNull(),
});

export const insertAuditLogSchema = createInsertSchema(auditLogTable).omit({
  id: true,
  occurred_at: true,
});

export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogTable.$inferSelect;
