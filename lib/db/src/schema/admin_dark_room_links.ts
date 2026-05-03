import { pgTable, serial, integer, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const adminDarkRoomLinksTable = pgTable(
  "admin_dark_room_links",
  {
    id: serial("id").primaryKey(),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 80 }).notNull(),
    url: text("url").notNull(),
    sort_order: integer("sort_order").notNull().default(0),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    by_user: index("admin_dark_room_links_user_idx").on(t.user_id, t.sort_order),
  }),
);

export type AdminDarkRoomLink = typeof adminDarkRoomLinksTable.$inferSelect;
