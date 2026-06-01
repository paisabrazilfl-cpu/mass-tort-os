import { pgTable, serial, integer, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// FAVORITES — per-user saved URLs (bookmarks). Each operator manages their own
// list; rows are scoped by user_id (firm_id retained for tenancy/reporting).
export const favoritesTable = pgTable(
  "favorites",
  {
    id: serial("id").primaryKey(),
    firm_id: integer("firm_id"),
    user_id: integer("user_id").notNull(),
    url: text("url").notNull(),
    label: varchar("label", { length: 255 }),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byUser: index("favorites_user_idx").on(t.user_id),
  }),
);

export const insertFavoriteSchema = createInsertSchema(favoritesTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type Favorite = typeof favoritesTable.$inferSelect;
export type InsertFavorite = z.infer<typeof insertFavoriteSchema>;
