// Task #22: backfill cases.created_by_user_id so the viewer ownership
// filter doesn't 403 legacy NULL-owner rows. Inferred from earliest
// audit_log entry, else falls back to a system admin user. Idempotent.
import crypto from "node:crypto";
import { promisify } from "node:util";
import { db, casesTable, auditLogTable, usersTable } from "@workspace/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getDefaultFirmId } from "./firm-bootstrap";

export const SYSTEM_USER_EMAIL = "system@mtos.local";
const SYSTEM_USER_NAME = "System (Backfill)";

const scryptAsync = promisify(crypto.scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

// Generate a salt:hash (both hex) value compatible with
// routes/auth.ts#hashPassword from random entropy that's immediately
// discarded. Result is a valid scrypt hash (so verifyPassword cannot
// crash on it) but the original password is unknown to anyone.
async function makeUnknownPasswordHash(): Promise<string> {
  const unknownPassword = crypto.randomBytes(64).toString("hex");
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await scryptAsync(unknownPassword, salt, 64);
  return `${salt}:${derivedKey.toString("hex")}`;
}

// Idempotent. If a row already exists at SYSTEM_USER_EMAIL it must be
// role=admin — otherwise we'd stamp legacy cases with whoever owns that
// row, which would be a privilege escalation (e.g. a viewer who somehow
// got the row created). Defense-in-depth pair to the RESERVED_EMAILS
// guard in routes/auth.ts.
export async function ensureSystemUser(): Promise<number> {
  // Common path: row already exists.
  const found = await selectSystemUser();
  if (found) return validateAndReturn(found);

  // Race-safe insert: ON CONFLICT DO NOTHING handles the case where a
  // concurrent caller created the row between our SELECT and INSERT.
  // Returns no row when a conflict happened — we then re-select and
  // validate the row that the other caller wrote.
  // Single-firm shell: every user row needs a firm anchor. Use the seeded
  // default firm; if it isn't there yet (extremely rare — boot ordering
  // bug), skip the system-user create and return null so the caller can
  // log+continue.
  const firmId = await getDefaultFirmId();
  if (firmId === null) {
    throw new Error(
      "case-ownership-backfill: no default firm — seedDefaultFirm must run before ensureSystemUser",
    );
  }
  const inserted = await db
    .insert(usersTable)
    .values({
      email: SYSTEM_USER_EMAIL,
      name: SYSTEM_USER_NAME,
      role: "admin",
      password_hash: await makeUnknownPasswordHash(),
      firm_id: firmId,
    })
    .onConflictDoNothing({ target: usersTable.email })
    .returning({ id: usersTable.id });

  if (inserted[0]) {
    logger.info({ id: inserted[0].id, email: SYSTEM_USER_EMAIL }, "Created system backfill user");
    return inserted[0].id;
  }

  // Conflict path: another caller won the race.
  const afterRace = await selectSystemUser();
  if (!afterRace) {
    throw new Error("ensureSystemUser: insert returned no row and re-select found nothing");
  }
  return validateAndReturn(afterRace);
}

async function selectSystemUser(): Promise<{ id: number; role: string } | undefined> {
  const rows = await db
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.email, SYSTEM_USER_EMAIL))
    .limit(1);
  return rows[0];
}

function validateAndReturn(row: { id: number; role: string }): number {
  if (row.role !== "admin") {
    throw new Error(
      `ensureSystemUser: refusing to use existing row at ${SYSTEM_USER_EMAIL} ` +
        `with role=${row.role} (expected admin). Operator remediation required.`,
    );
  }
  return row.id;
}

// Recover details.created_by_user_id from the earliest audit_log entries
// for a case. Returns null when no entry references a real user id.
export async function inferOwnerFromAuditLog(case_id: string): Promise<number | null> {
  const rows = await db
    .select({ details: auditLogTable.details })
    .from(auditLogTable)
    .where(
      and(
        eq(auditLogTable.entity_type, "case"),
        eq(auditLogTable.entity_id, case_id),
      ),
    )
    .orderBy(asc(auditLogTable.occurred_at))
    // Read enough rows to cover atypical case histories where many
    // status / decryption / route entries pile in front of the
    // intake-time entry that carries created_by_user_id.
    .limit(100);

  for (const row of rows) {
    const details = row.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) continue;
    const candidate = (details as Record<string, unknown>)["created_by_user_id"];
    if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate <= 0) continue;
    const userExists = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, candidate))
      .limit(1);
    if (userExists[0]) return userExists[0].id;
  }
  return null;
}

export interface BackfillResult {
  scanned: number;
  inferredFromAudit: number;
  fallbackToSystem: number;
  systemUserId: number;
}

// Returns true when both `cases` and `mtos_users` tables exist. Lets the
// post-merge runner skip the backfill on a fresh/blank DB where the
// schema is about to be created from scratch by a follow-up `db push`
// (no rows to backfill, and a NULL-aware insert path will create the
// table with NOT NULL already in place).
export async function ownershipTablesExist(): Promise<boolean> {
  // Scope to the current schema (`current_schema()`) so this works
  // correctly when the connection is pinned to a non-public schema
  // (multi-tenant deployments, test databases, etc.).
  const result = await db.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'cases'
      ) AS cases_exists,
      EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'mtos_users'
      ) AS users_exists
  `);
  const row = (result as unknown as { rows: Array<{ cases_exists: boolean; users_exists: boolean }> }).rows[0];
  return Boolean(row?.cases_exists && row?.users_exists);
}

// Run the backfill. Safe to call from a script, test, or admin endpoint.
export async function backfillCaseOwnership(): Promise<BackfillResult> {
  const systemUserId = await ensureSystemUser();
  const orphans = await db
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(isNull(casesTable.created_by_user_id));

  let inferredFromAudit = 0;
  let fallbackToSystem = 0;
  for (const { id } of orphans) {
    const inferred = await inferOwnerFromAuditLog(id);
    const owner = inferred ?? systemUserId;
    if (inferred !== null) inferredFromAudit++;
    else fallbackToSystem++;
    await db
      .update(casesTable)
      .set({ created_by_user_id: owner, updated_at: new Date() })
      .where(and(eq(casesTable.id, id), isNull(casesTable.created_by_user_id)));
  }

  return {
    scanned: orphans.length,
    inferredFromAudit,
    fallbackToSystem,
    systemUserId,
  };
}

// Idempotent: ownership indexes + NOT NULL on created_by_user_id.
export async function applyOwnershipDdl(): Promise<void> {
  await db.execute(sql`CREATE INDEX IF NOT EXISTS cases_created_by_user_id_idx ON cases (created_by_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS cases_assigned_to_idx ON cases (assigned_to)`);
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'cases'
          AND column_name = 'created_by_user_id'
          AND is_nullable = 'YES'
      ) THEN
        ALTER TABLE cases ALTER COLUMN created_by_user_id SET NOT NULL;
      END IF;
    END $$;
  `);
}
