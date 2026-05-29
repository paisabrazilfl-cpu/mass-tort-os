/**
 * Vapi webhook signature + tool-bearer auth helpers. Split out of
 * lib/voice/vapi.ts because they depend on routes/integrations, which
 * forms a boot-time import cycle with lib/voice/index → lib/voice/vapi.
 *
 * These helpers are only invoked from request handlers, never at module
 * init, so loading this file lazily through the route layer is safe.
 *
 * Vapi authenticates webhooks two different ways:
 *   1. HMAC-SHA256 of the raw body using the secret on the integration
 *      vault (`api_key`), header `X-Vapi-Signature` (hex digest, lower).
 *   2. Static bearer token sent as `Authorization: Bearer <token>` —
 *      used when the assistant is configured for tool callbacks.
 * The vault uses field `api_key` (signing) + optional `client_secret`
 * (static bearer for tool callbacks).
 */
import crypto from "crypto";
import { resolveProvider, isResolved } from "../provider-router";

export interface VapiCredentials {
  apiKey: string;
  toolBearer: string | null;
  integrationId: number;
}

/**
 * Load the active Vapi credentials. Resolution goes through the provider
 * router (`resolveProvider("voice")`) — the SAME path tort-agent provisioning
 * uses to pick the integration row and bake the callback bearer. This is
 * critical: webhook/tool-callback verification (verifyVapiSignature,
 * verifyVapiToolBearer, checkBearer) must validate against the exact same
 * integration row whose `client_secret` was embedded in the provisioned
 * assistant. Selecting "the first active vapi row" here would silently
 * mismatch in multi-integration setups and 401 every tool callback.
 */
export async function loadVapiCredentials(): Promise<VapiCredentials | null> {
  const resolved = await resolveProvider("voice");
  if (!isResolved(resolved) || resolved.provider !== "vapi") return null;

  const creds = resolved.credentials as Record<string, unknown>;
  const apiKey = typeof creds.api_key === "string" ? creds.api_key.trim() : "";
  if (!apiKey) return null;
  const toolBearer =
    typeof creds.client_secret === "string" && creds.client_secret.trim().length > 0
      ? creds.client_secret.trim()
      : null;
  return { apiKey, toolBearer, integrationId: resolved.integration_id };
}

export interface SignatureCheckResult {
  ok: boolean;
  reason?: "no_credentials" | "no_signature" | "bad_signature";
}

export async function verifyVapiSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<SignatureCheckResult> {
  const creds = await loadVapiCredentials();
  if (!creds) return { ok: false, reason: "no_credentials" };

  const sigHeader = pickHeader(headers, "x-vapi-signature");
  if (sigHeader) {
    const expected = crypto.createHmac("sha256", creds.apiKey).update(rawBody).digest("hex");
    if (timingSafeEqualHex(expected, sigHeader.trim().toLowerCase())) return { ok: true };
    return { ok: false, reason: "bad_signature" };
  }

  const auth = pickHeader(headers, "authorization");
  if (auth?.toLowerCase().startsWith("bearer ") && creds.toolBearer) {
    const token = auth.slice(7).trim();
    if (timingSafeEqualString(token, creds.toolBearer)) return { ok: true };
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: false, reason: "no_signature" };
}

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
