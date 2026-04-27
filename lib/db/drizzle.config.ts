import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  // `out` is required by drizzle-kit's check-command config validator
  // (v0.31.x), even though this project uses the push-based workflow
  // and does not commit migration files. Without `out`, `drizzle-kit
  // check` falls through to AWS Data API driver detection and dies
  // with a misleading "secretArn: 'postgresql'" error. The folder is
  // gitignored and only materialises if a developer explicitly runs
  // `drizzle-kit generate`.
  out: path.join(__dirname, "./drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
