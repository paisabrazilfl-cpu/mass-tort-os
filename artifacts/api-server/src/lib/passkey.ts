/**
 * Passkey (WebAuthn / FIDO2) sign-in support.
 *
 * Two surfaces:
 *   - Enrollment — a logged-in user registers a passkey from the Security
 *     page (register/options → register/verify).
 *   - Login — the login page runs a discoverable-credential ceremony
 *     (login/options → login/verify): the browser offers any passkey bound
 *     to this site, no username typed.
 *
 * Storage:
 *   - webauthn_credentials — one row per enrolled passkey (public key +
 *     signature counter). The private key never leaves the user's device.
 *   - webauthn_challenges — short-lived (5 min) server-issued challenges,
 *     keyed by an opaque handle so a stateless login page can complete the
 *     ceremony. Consumed (deleted) on use — single-use, race-proof.
 *
 * RP (relying party) identity is derived from APP_PUBLIC_URL so the verifier
 * (this API) and the page the user signs in on agree on rpID + origin even
 * though they sit on different Railway domains. Both are env-overridable
 * (WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN).
 */
import crypto from "node:crypto";
import { pool } from "@workspace/db";

// WebAuthn authenticator transport values from the W3C spec.
type AuthenticatorTransportFuture = "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";
import { resolveAppPublicUrl } from "./email-verification";

function resolveRp(): { rpID: string; rpName: string; origin: string } {
  const rpName = "Mass Tort OS";
  const origin = (process.env["WEBAUTHN_ORIGIN"]?.trim() || resolveAppPublicUrl()).replace(/\/+$/, "");
  let rpID = process.env["WEBAUTHN_RP_ID"]?.trim() || "";
  if (!rpID) {
    try {
      rpID = new URL(origin).hostname;
    } catch {
      rpID = "localhost";
    }
  }
  return { rpID, rpName, origin };
}

/** Relying-party identity, resolved once at module load. */
export const RP = resolveRp();

export interface StoredCredential {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: string; // base64url of the COSE public key
  counter: number;
  transports: string | null;
  device_name: string | null;
  created_at: Date;
  last_used_at: Date | null;
}

/** Parse the JSON-encoded transports column back into the typed array. */
export function parseTransports(raw: string | null): AuthenticatorTransportFuture[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as AuthenticatorTransportFuture[]) : [];
  } catch {
    return [];
  }
}

// ── Challenge store ─────────────────────────────────────────────────────────

/** Persist a server-issued challenge; returns an opaque handle for the client. */
export async function saveChallenge(
  purpose: "register" | "authenticate",
  userId: number | null,
  challenge: string,
): Promise<string> {
  const handle = crypto.randomBytes(24).toString("hex");
  await pool.query(
    `INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '5 minutes')`,
    [handle, challenge, purpose, userId],
  );
  return handle;
}

/** Atomically consume a challenge — single-use, returns null if absent/expired. */
export async function consumeChallenge(
  handle: string,
  purpose: "register" | "authenticate",
): Promise<{ challenge: string; user_id: number | null } | null> {
  const r = await pool.query<{ challenge: string; user_id: number | null }>(
    `DELETE FROM webauthn_challenges
       WHERE id = $1 AND purpose = $2 AND expires_at > NOW()
       RETURNING challenge, user_id`,
    [handle, purpose],
  );
  return r.rows[0] ?? null;
}

// ── Credential store ────────────────────────────────────────────────────────

export async function listCredentials(userId: number): Promise<StoredCredential[]> {
  const r = await pool.query<StoredCredential>(
    `SELECT id, user_id, credential_id, public_key, counter, transports, device_name,
            created_at, last_used_at
       FROM webauthn_credentials WHERE user_id = $1 ORDER BY id`,
    [userId],
  );
  return r.rows;
}

export async function getCredentialById(credentialId: string): Promise<StoredCredential | null> {
  const r = await pool.query<StoredCredential>(
    `SELECT id, user_id, credential_id, public_key, counter, transports, device_name,
            created_at, last_used_at
       FROM webauthn_credentials WHERE credential_id = $1 LIMIT 1`,
    [credentialId],
  );
  return r.rows[0] ?? null;
}

export async function insertCredential(args: {
  userId: number;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceName: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO webauthn_credentials
       (user_id, credential_id, public_key, counter, transports, device_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (credential_id) DO NOTHING`,
    [
      args.userId,
      args.credentialId,
      args.publicKey,
      args.counter,
      JSON.stringify(args.transports),
      args.deviceName,
    ],
  );
}

/** Advance the stored signature counter — clone-detection per the WebAuthn spec. */
export async function updateCounter(credentialId: string, counter: number): Promise<void> {
  await pool.query(
    `UPDATE webauthn_credentials SET counter = $2, last_used_at = NOW() WHERE credential_id = $1`,
    [counter, credentialId],
  );
}

/** Delete one of the caller's own passkeys. Returns false if it wasn't theirs. */
export async function deleteCredential(userId: number, id: number): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  return r.rows.length > 0;
}
