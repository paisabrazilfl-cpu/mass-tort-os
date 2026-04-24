import { pgTable, serial, varchar, text, integer, timestamp, customType } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Postgres-backed binary storage for uploaded template PDFs.
 *
 * Why a DB column instead of disk?
 * The deployed environment is autoscale: containers are ephemeral and there
 * may be multiple replicas. Files written to local disk vanish on restart and
 * are invisible to other replicas. Storing the bytes in Postgres keeps every
 * uploaded template durable and available to every API replica + the worker.
 *
 * storage_key is what gets persisted in document_templates.storage_path so the
 * existing column shape is preserved.
 */
export const templateFilesTable = pgTable("template_files", {
  id: serial("id").primaryKey(),
  storage_key: varchar("storage_key", { length: 255 }).notNull().unique(),
  file_name: varchar("file_name", { length: 255 }).notNull(),
  content_type: varchar("content_type", { length: 100 }).notNull().default("application/pdf"),
  content: bytea("content").notNull(),
  hash: text("hash").notNull(),
  size_bytes: integer("size_bytes").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export type TemplateFile = typeof templateFilesTable.$inferSelect;
