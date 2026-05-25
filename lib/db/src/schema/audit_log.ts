import {
  pgTable,
  serial,
  integer,
  varchar,
  jsonb,
  text,
  timestamp,
  index,
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
  firm_id: integer("firm_id"),
  occurred_at: timestamp("occurred_at").defaultNow().notNull(),
}, (t) => ({
  entityIdx: index("audit_log_entity_idx").on(t.entity_type, t.entity_id, t.occurred_at),
  occurredAtIdx: index("audit_log_occurred_at_idx").on(t.occurred_at),
  actionIdx: index("audit_log_action_idx").on(t.action, t.occurred_at),
  entityTypeIdx: index("audit_log_entity_type_idx").on(t.entity_type, t.occurred_at),
  firmIdx: index("audit_log_firm_idx").on(t.firm_id),
}));

export const insertAuditLogSchema = createInsertSchema(auditLogTable).omit({
  id: true,
  occurred_at: true,
});

export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogTable.$inferSelect;
