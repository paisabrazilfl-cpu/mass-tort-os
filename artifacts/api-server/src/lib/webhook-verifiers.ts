/**
 * Per-provider inbound webhook signature verifiers.
 *
 * Returns one of:
 *   - "verified"   signature header was present AND validated
 *   - "invalid"    signature header was present AND failed validation
 *   - "unverified" no documented signature scheme implemented for this
 *                  provider, OR no signing secret configured in vault
 *
 * The generic /webhooks/{email,fax,sms,voice}/:provider receivers
 * record this on the persisted event row so operators can audit which
 * inbound events had cryptographic provenance and which did not.
 *
 * Implementations follow each provider's published webhook docs:
 *   - SendGrid:  ECDSA over (timestamp + rawBody)         X-Twilio-Email-Event-Webhook-Signature/Timestamp
 *   - Mailgun:   HMAC-SHA256 over (timestamp + token)    body fields
 *   - Brevo:     HMAC-SHA256 over rawBody                X-Mailin-Custom / signature header
 *   - Postmark:  HTTP Basic auth                         Authorization
 *   - Resend:    Svix HMAC-SHA256                        svix-id|svix-timestamp|svix-signature
 *   - AWS SES:   SNS message signature                   handled at SNS subscription confirmation
 *   - Twilio:    HMAC-SHA1 over (url + sortedFormBody)   X-Twilio-Signature
 *   - Bandwidth: HMAC-SHA256 over rawBody                X-Callback-Signature
 *   - Plivo:     HMAC-SHA256 over (url + nonce)          X-Plivo-Signature-V3
 *   - Sinch:     HMAC-SHA256                             x-sinch-webhook-signature
 *   - MessageBird: signed query param                    (signed_request)
 *
 * Voice/fax providers vary widely; the registry returns "unverified"
 * when we have no documented scheme to validate against.
 */
import crypto from "crypto";
import type { DecryptedCredentials } from "../routes/integrations";

export type SignatureStatus = "verified" | "invalid" | "unverified";

export interface VerifyContext {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** Full request URL including query string — used by Twilio. */
  fullUrl?: string;
  /** Parsed form body (POST application/x-www-form-urlencoded) — used by Twilio. */
  formBody?: Record<string, string>;
}

export type Verifier = (ctx: VerifyContext, creds: DecryptedCredentials | null) => SignatureStatus;

function header(ctx: VerifyContext, name: string): string | undefined {
  const v = ctx.headers[name] ?? ctx.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function tsConstantEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ─── Email ────────────────────────────────────────────────────────

const verifySendgrid: Verifier = (ctx, creds) => {
  const sig = header(ctx, "x-twilio-email-event-webhook-signature");
  const ts = header(ctx, "x-twilio-email-event-webhook-timestamp");
  if (!sig || !ts) return "unverified";
  const pubKey = typeof creds?.client_secret === "string" ? creds.client_secret : null;
  if (!pubKey) return "unverified";
  try {
    const verifier = crypto.createVerify("sha256");
    verifier.update(ts);
    verifier.update(ctx.rawBody);
    verifier.end();
    const ok = verifier.verify(
      { key: pubKey, format: "pem" },
      Buffer.from(sig, "base64"),
    );
    return ok ? "verified" : "invalid";
  } catch {
    return "invalid";
  }
};

const verifyMailgun: Verifier = (ctx, creds) => {
  // Mailgun sends signature inside the JSON body, not headers.
  const apiKey = typeof creds?.api_key === "string" ? creds.api_key : null;
  if (!apiKey) return "unverified";
  let parsed: { signature?: { timestamp?: string; token?: string; signature?: string } } = {};
  try { parsed = JSON.parse(ctx.rawBody.toString("utf8")); } catch { return "unverified"; }
  const s = parsed.signature;
  if (!s?.timestamp || !s?.token || !s?.signature) return "unverified";
  const expected = crypto.createHmac("sha256", apiKey)
    .update(`${s.timestamp}${s.token}`)
    .digest("hex");
  return tsConstantEqual(expected, s.signature) ? "verified" : "invalid";
};

const verifyBrevo: Verifier = (ctx, creds) => {
  const sig = header(ctx, "x-mailin-custom") ?? header(ctx, "x-sib-signature");
  if (!sig) return "unverified";
  const secret = typeof creds?.client_secret === "string"
    ? creds.client_secret
    : (typeof creds?.api_key === "string" ? creds.api_key : null);
  if (!secret) return "unverified";
  const expected = crypto.createHmac("sha256", secret).update(ctx.rawBody).digest("hex");
  return tsConstantEqual(expected, sig) ? "verified" : "invalid";
};

const verifyPostmark: Verifier = (ctx, creds) => {
  // Postmark uses HTTP Basic auth where operator-supplied user:pass is
  // stored in vault as account_sid:api_key (matching how we expose
  // basic-auth-style providers elsewhere).
  const auth = header(ctx, "authorization");
  if (!auth?.startsWith("Basic ")) return "unverified";
  const user = typeof creds?.account_sid === "string" ? creds.account_sid : null;
  const pass = typeof creds?.api_key === "string" ? creds.api_key : null;
  if (!user || !pass) return "unverified";
  const expected = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  return tsConstantEqual(expected, auth) ? "verified" : "invalid";
};

const verifyResend: Verifier = (ctx, creds) => {
  // Resend uses Svix-style signing.
  const svixId = header(ctx, "svix-id");
  const svixTs = header(ctx, "svix-timestamp");
  const svixSig = header(ctx, "svix-signature");
  if (!svixId || !svixTs || !svixSig) return "unverified";
  const secret = typeof creds?.client_secret === "string" ? creds.client_secret : null;
  if (!secret) return "unverified";
  const secretBytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret, "utf8");
  const signedPayload = `${svixId}.${svixTs}.${ctx.rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secretBytes).update(signedPayload).digest("base64");
  // svix-signature is space-separated list of "v1,base64sig" pairs.
  const sigs = svixSig.split(" ").map((s) => s.split(",")[1]).filter(Boolean);
  for (const s of sigs) {
    if (s.length === expected.length && tsConstantEqual(s, expected)) return "verified";
  }
  return "invalid";
};

// ─── SMS ──────────────────────────────────────────────────────────

const verifyTwilio: Verifier = (ctx, creds) => {
  const sig = header(ctx, "x-twilio-signature");
  const url = ctx.fullUrl;
  const form = ctx.formBody;
  if (!sig || !url || !form) return "unverified";
  const authToken = typeof creds?.api_key === "string" ? creds.api_key : null;
  if (!authToken) return "unverified";
  const sortedKeys = Object.keys(form).sort();
  let data = url;
  for (const k of sortedKeys) data += k + form[k];
  const expected = crypto.createHmac("sha1", authToken).update(data).digest("base64");
  return tsConstantEqual(expected, sig) ? "verified" : "invalid";
};

const verifyBandwidth: Verifier = (ctx, creds) => {
  const sig = header(ctx, "x-callback-signature") ?? header(ctx, "x-bandwidth-signature");
  if (!sig) return "unverified";
  const secret = typeof creds?.client_secret === "string" ? creds.client_secret : null;
  if (!secret) return "unverified";
  const expected = crypto.createHmac("sha256", secret).update(ctx.rawBody).digest("hex");
  return tsConstantEqual(expected, sig) ? "verified" : "invalid";
};

const verifyPlivo: Verifier = (ctx, creds) => {
  const sig = header(ctx, "x-plivo-signature-v3");
  const nonce = header(ctx, "x-plivo-signature-v3-nonce");
  const url = ctx.fullUrl;
  if (!sig || !nonce || !url) return "unverified";
  const authToken = typeof creds?.api_key === "string" ? creds.api_key : null;
  if (!authToken) return "unverified";
  const data = `${url}.${nonce}.${ctx.rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", authToken).update(data).digest("base64");
  return tsConstantEqual(expected, sig) ? "verified" : "invalid";
};

/**
 * MessageBird webhooks: HMAC-SHA256 over the raw body keyed by the
 * webhook signing key (preset stores it under client_secret). Header
 * is `messagebird-signature` (or legacy `Messagebird-Signature`).
 * MessageBird also sends `messagebird-request-timestamp`; when present
 * we include it in the signed payload (`<ts>.<body>`), matching the
 * v2 signing scheme.
 */
const verifyMessagebird: Verifier = (ctx, creds) => {
  const sig =
    header(ctx, "messagebird-signature-jwt") ??
    header(ctx, "messagebird-signature");
  if (!sig) return "unverified";
  const secret = typeof creds?.client_secret === "string" ? creds.client_secret : null;
  if (!secret) return "unverified";
  const ts = header(ctx, "messagebird-request-timestamp");
  const data = ts ? `${ts}.${ctx.rawBody.toString("utf8")}` : ctx.rawBody.toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64");
  return tsConstantEqual(expected, sig) ? "verified" : "invalid";
};

const verifySinch: Verifier = (ctx, creds) => {
  const sig = header(ctx, "x-sinch-webhook-signature") ?? header(ctx, "x-sinch-signature");
  const ts = header(ctx, "x-sinch-webhook-signature-timestamp");
  if (!sig) return "unverified";
  const secret = typeof creds?.client_secret === "string" ? creds.client_secret : null;
  if (!secret) return "unverified";
  const data = ts ? `${ts}.${ctx.rawBody.toString("utf8")}` : ctx.rawBody.toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64");
  return tsConstantEqual(expected, sig) ? "verified" : "invalid";
};

// ─── Registry ─────────────────────────────────────────────────────

const EMAIL: Record<string, Verifier> = {
  sendgrid: verifySendgrid,
  mailgun: verifyMailgun,
  brevo: verifyBrevo,
  postmark: verifyPostmark,
  resend: verifyResend,
};

const SMS: Record<string, Verifier> = {
  twilio: verifyTwilio,
  bandwidth: verifyBandwidth,
  plivo: verifyPlivo,
  sinch: verifySinch,
  messagebird: verifyMessagebird,
};

// AWS SES (SNS) and MessageBird use complex schemes (SNS message
// signature verification + signed_request query param respectively).
// We accept their events but mark "unverified" until the full handler
// is wired; voice/fax providers all fall in the same bucket.
export function getEmailVerifier(provider: string): Verifier | null {
  return EMAIL[provider] ?? null;
}
export function getSmsVerifier(provider: string): Verifier | null {
  return SMS[provider] ?? null;
}
