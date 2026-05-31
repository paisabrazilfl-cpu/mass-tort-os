import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { firmsTable } from "./firms";
import { usersTable } from "./users";

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  // Firm tenancy + creator. Nullable for backward-compatibility with any
  // pre-existing rows; every Sites-AI conversation always sets both so the
  // list/read endpoints can scope strictly by firm.
  firmId: integer("firm_id").references(() => firmsTable.id),
  userId: integer("user_id").references(() => usersTable.id),
  // Domain scope tag, e.g. "sites" for the Sites AI assistant. Lets one table
  // back multiple distinct assistants without cross-talk.
  scope: text("scope").notNull().default("general"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
