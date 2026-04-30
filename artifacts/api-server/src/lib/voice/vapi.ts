/**
 * Vapi voice adapter — outbound API calls and inbound signature verify.
 *
 * Vapi authenticates webhooks two different ways depending on how the
 * assistant was configured:
 *   1. HMAC-SHA256 of the raw body using the secret on the integration
 *      vault (`api_key` reused as the signing secret), header
 *      `X-Vapi-Signature` (hex digest, lowercase).
 *   2. Static bearer token sent as `Authorization: Bearer <token>` —
 *      used when the assistant is configured to send tool callbacks.
 *
 * We accept EITHER successfully — operators can pick whichever they
 * prefer in the Vapi dashboard. A request with neither valid HMAC nor
 * matching bearer is rejected.
 *
 * The vault row uses field `api_key` (Vapi private API key, used both
 * for outbound calls and as the HMAC signing secret) and an optional
 * `client_secret` field used as the static bearer for tool callbacks.
 */
import { db, integrationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import crypto from "crypto";
import { getIntegrationCredentialsById } from "../../routes/integrations";
import { logger } from "../logger";

export interface VapiCredentials {
  apiKey: string;
  toolBearer: string | null;
  integrationId: number;
}

export async function loadVapiCredentials(): Promise<VapiCredentials | null> {
  const rows = await db
    .select({ id: integrationsTable.id })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.provider, "vapi"),
        eq(integrationsTable.status, "active"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const creds = await getIntegrationCredentialsById(row.id);
  if (!creds) return null;
  if (creds._decryption_errors && creds._decryption_errors.length) {
    logger.error(
      { fields: creds._decryption_errors, integration_id: row.id },
      "vapi credential decryption failed",
    );
    return null;
  }
  const apiKey = typeof creds.api_key === "string" ? creds.api_key.trim() : "";
  if (!apiKey) return null;
  const toolBearer =
    typeof creds.client_secret === "string" && creds.client_secret.trim().length > 0
      ? creds.client_secret.trim()
      : null;
  return { apiKey, toolBearer, integrationId: row.id };
}

export interface SignatureCheckResult {
  ok: boolean;
  reason?: "no_credentials" | "no_signature" | "bad_signature";
}

/**
 * Verify a Vapi webhook request. Accepts either a valid HMAC signature
 * over the raw body OR a matching static bearer token. Returns
 * { ok: true } when accepted; otherwise { ok: false, reason }.
 *
 * NEVER throws — webhook handlers must always 200 OK so the provider
 * stops retrying. The caller decides whether to mutate state based on
 * the boolean.
 */
export async function verifyVapiSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<SignatureCheckResult> {
  const creds = await loadVapiCredentials();
  if (!creds) return { ok: false, reason: "no_credentials" };

  // Path 1: HMAC signature
  const sigHeader = pickHeader(headers, "x-vapi-signature");
  if (sigHeader) {
    const expected = crypto
      .createHmac("sha256", creds.apiKey)
      .update(rawBody)
      .digest("hex");
    if (timingSafeEqualHex(expected, sigHeader.trim().toLowerCase())) {
      return { ok: true };
    }
    return { ok: false, reason: "bad_signature" };
  }

  // Path 2: bearer token
  const auth = pickHeader(headers, "authorization");
  if (auth?.toLowerCase().startsWith("bearer ") && creds.toolBearer) {
    const token = auth.slice(7).trim();
    if (timingSafeEqualString(token, creds.toolBearer)) {
      return { ok: true };
    }
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: false, reason: "no_signature" };
}

/**
 * Authenticate an inbound tool callback. Vapi tool callbacks always
 * use the static bearer (the API key is too sensitive to bake into
 * the assistant config). Used by routes/vapi-tools.ts.
 */
export async function verifyVapiToolBearer(
  headers: Record<string, string | string[] | undefined>,
): Promise<boolean> {
  const creds = await loadVapiCredentials();
  if (!creds?.toolBearer) return false;
  const auth = pickHeader(headers, "authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) return false;
  const token = auth.slice(7).trim();
  return timingSafeEqualString(token, creds.toolBearer);
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}
