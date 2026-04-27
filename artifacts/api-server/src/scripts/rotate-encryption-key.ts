/**
 * Encryption key rotation migration.
 *
 * Walks every row in every table that contains encrypted columns, decrypts
 * each cell using its embedded version (auto-handled by `decrypt()`),
 * and re-encrypts using the CURRENT_KEY_VERSION (i.e., the new key).
 *
 * Pre-conditions:
 *  - ENCRYPTION_KEY_V1 is set in env (the OLD key) — for legacy decrypt
 *  - ENCRYPTION_KEY_V2 is set in env (the NEW key) — for re-encrypt
 *  - Note: the bare ENCRYPTION_KEY env var is also accepted as a v1 alias
 *    (legacy compatibility), but ENCRYPTION_KEY_V1 is preferred.
 *
 * Idempotent: rows already tagged with the current version are skipped.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/rotate-encryption-key.ts
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/rotate-encryption-key.ts --dry-run
 */
import { db, leadsTable, integrationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  decrypt,
  encrypt,
  getCurrentKeyVersion,
  isKeyConfigured,
  ENCRYPTED_FIELDS,
} from "../lib/encryption";

const DRY_RUN = process.argv.includes("--dry-run");

interface Stats {
  scanned: number;
  rotated: number;
  alreadyCurrent: number;
  errors: number;
  fieldsRotated: number;
}

function ciphertextVersion(value: string): number | null {
  if (!value || typeof value !== "string") return null;
  if (!value.startsWith("enc:v")) return value.startsWith("enc:") ? 0 : null;
  const colon = value.indexOf(":", 5);
  if (colon < 0) return null;
  const v = parseInt(value.slice(5, colon), 10);
  return Number.isFinite(v) ? v : null;
}

async function rotateLeads(targetVersion: number): Promise<Stats> {
  const stats: Stats = {
    scanned: 0,
    rotated: 0,
    alreadyCurrent: 0,
    errors: 0,
    fieldsRotated: 0,
  };

  const rows = await db.select().from(leadsTable);
  for (const row of rows) {
    stats.scanned += 1;
    const updates: Record<string, string> = {};
    let rowHadStaleField = false;

    for (const field of ENCRYPTED_FIELDS) {
      const cell = (row as Record<string, unknown>)[field];
      if (typeof cell !== "string" || !cell.startsWith("enc:")) continue;
      const v = ciphertextVersion(cell);
      if (v === targetVersion) continue;
      rowHadStaleField = true;

      try {
        const plain = decrypt(cell, field, String(row.id));
        if (plain === "[DECRYPTION_ERROR]") {
          console.error(
            `  lead id=${row.id} field=${field}: DECRYPTION FAILED — leaving untouched`,
          );
          stats.errors += 1;
          continue;
        }
        updates[field] = encrypt(plain, field, String(row.id));
        stats.fieldsRotated += 1;
      } catch (e) {
        console.error(
          `  lead id=${row.id} field=${field}: ${(e as Error).message}`,
        );
        stats.errors += 1;
      }
    }

    if (!rowHadStaleField) {
      stats.alreadyCurrent += 1;
      continue;
    }

    if (Object.keys(updates).length > 0) {
      if (DRY_RUN) {
        console.log(
          `  [dry-run] would rotate lead id=${row.id} fields=[${Object.keys(updates).join(",")}]`,
        );
      } else {
        await db.update(leadsTable).set(updates).where(eq(leadsTable.id, row.id));
      }
      stats.rotated += 1;
    }
  }
  return stats;
}

async function rotateIntegrations(targetVersion: number): Promise<Stats> {
  const stats: Stats = {
    scanned: 0,
    rotated: 0,
    alreadyCurrent: 0,
    errors: 0,
    fieldsRotated: 0,
  };

  // integrations.config is a JSON blob shaped like { credentials: {k: enc:..., ...}, ...other }.
  // The encrypted values live inside the `credentials` sub-object.
  const rows = await db.select().from(integrationsTable);
  for (const row of rows) {
    stats.scanned += 1;
    const config = (row as { config?: unknown }).config;
    const creds =
      config && typeof config === "object"
        ? (config as Record<string, unknown>).credentials
        : null;

    if (!creds || typeof creds !== "object") {
      stats.alreadyCurrent += 1;
      continue;
    }

    const updatedCreds: Record<string, unknown> = { ...(creds as Record<string, unknown>) };
    let rowHadStaleField = false;

    for (const [k, v] of Object.entries(updatedCreds)) {
      if (typeof v !== "string" || !v.startsWith("enc:")) continue;
      const cv = ciphertextVersion(v);
      if (cv === targetVersion) continue;
      rowHadStaleField = true;

      try {
        const plain = decrypt(v, `integration:${k}`, String(row.id));
        if (plain === "[DECRYPTION_ERROR]") {
          console.error(
            `  integration id=${row.id} key=${k}: DECRYPTION FAILED — leaving untouched`,
          );
          stats.errors += 1;
          continue;
        }
        updatedCreds[k] = encrypt(plain, `integration:${k}`, String(row.id));
        stats.fieldsRotated += 1;
      } catch (e) {
        console.error(
          `  integration id=${row.id} key=${k}: ${(e as Error).message}`,
        );
        stats.errors += 1;
      }
    }

    if (!rowHadStaleField) {
      stats.alreadyCurrent += 1;
      continue;
    }

    const updatedConfig = { ...(config as Record<string, unknown>), credentials: updatedCreds };

    if (DRY_RUN) {
      console.log(`  [dry-run] would rotate integration id=${row.id}`);
    } else {
      await db
        .update(integrationsTable)
        .set({ config: updatedConfig })
        .where(eq(integrationsTable.id, row.id));
    }
    stats.rotated += 1;
  }
  return stats;
}

async function main() {
  const target = getCurrentKeyVersion();
  console.log(`=== ENCRYPTION KEY ROTATION → v${target}${DRY_RUN ? " [DRY RUN]" : ""} ===`);

  if (!isKeyConfigured(target)) {
    console.error(
      `FATAL: ENCRYPTION_KEY_V${target} is not configured. Cannot proceed.`,
    );
    process.exit(2);
  }

  const legacyOk = isKeyConfigured(1);
  if (!legacyOk) {
    console.warn(
      "WARNING: ENCRYPTION_KEY_V1 (and ENCRYPTION_KEY) are both unset. Rows tagged with v1 will fail to decrypt.",
    );
  }

  console.log("\n--- Leads ---");
  const leadStats = await rotateLeads(target);
  console.log(JSON.stringify(leadStats, null, 2));

  console.log("\n--- Integrations ---");
  const intStats = await rotateIntegrations(target);
  console.log(JSON.stringify(intStats, null, 2));

  const totalErrors = leadStats.errors + intStats.errors;
  console.log(
    `\n=== DONE — leads rotated=${leadStats.rotated}, integrations rotated=${intStats.rotated}, fields=${
      leadStats.fieldsRotated + intStats.fieldsRotated
    }, errors=${totalErrors} ===`,
  );

  if (totalErrors > 0) {
    console.error("\nNon-zero errors — investigate before deleting the legacy key.");
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => {
  console.error("ROTATION FAILED:", e);
  process.exit(1);
});
