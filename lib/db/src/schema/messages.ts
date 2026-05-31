import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";

// A file attached to a chat message. `objectPath` is the storage path returned
// by the upload-url endpoint (already prefixed with `/objects/`). Files live in
// the private object dir and are served back through a firm-scoped endpoint.
export interface MessageAttachment {
  name: string;
  objectPath: string;
  size: number;
  contentType: string;
}

// A proposed privileged action the Sites AI wants the operator to confirm.
// NOTHING executes until the operator confirms AND passes the per-action RBAC
// re-check. `kind` selects the executor branch; `params` carries its payload.
export type SitesActionKind = "rebuild_all" | "seo_rebuild_all" | "create_site" | "edit_site";

export interface SitesActionProposal {
  kind: SitesActionKind;
  summary: string;
  params: Record<string, unknown>;
}

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  // Optional uploaded files attached to this (user) message.
  attachments: jsonb("attachments").$type<MessageAttachment[]>().notNull().default([]),
  // Optional privileged action proposed by the assistant on this message.
  proposal: jsonb("proposal").$type<SitesActionProposal | null>(),
  // Lifecycle of the proposal: null (no proposal) | "pending" | "confirmed"
  // (executing) | "executed" | "cancelled" | "failed".
  proposalStatus: text("proposal_status"),
  // Structured result of an executed/failed proposal (counts, slug, error).
  proposalResult: jsonb("proposal_result").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
