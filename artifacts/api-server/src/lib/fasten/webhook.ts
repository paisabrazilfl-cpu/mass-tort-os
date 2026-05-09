/**
 * Fasten Connect webhook signature verification.
 * Per https://docs.connect.fastenhealth.com/webhooks/verification —
 *   header: `Fasten-Signature` carrying `t=<unix-ts>,v1=<hex hmac>`
 *   secret: the value Fasten printed once when the webhook was registered
 *           (stored as `client_secret` on the fasten_connect integration row)
 *   payload: `<timestamp>.<rawBody>` HMAC-SHA256
 *
 * Returns "ok" / "missing" / "bad_signature" / "no_secret" so the route
 * handler can decide whether to mutate state or quietly ack the webhook.
 */
import crypto from "crypto";

export type FastenSigStatus = "ok" | "missing" | "bad_signature" | "no_secret" | "stale";

const TOLERANCE_SECONDS = 300; // 5 min replay window

interface ParsedHeader {
  timestamp: number | null;
  v1: string | null;
}

function parseSignatureHeader(header: string | undefined | null): ParsedHeader {
  if (!header) return { timestamp: null, v1: null };
  const parts = header.split(",").map((s) => s.trim());
  let timestamp: number | null = null;
  let v1: string | null = null;
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (!k || !v) continue;
    if (k === "t") {
      const n = Number(v);
      timestamp = Number.isFinite(n) ? n : null;
    } else if (k === "v1") {
      v1 = v;
    }
  }
  return { timestamp, v1 };
}

export function verifyFastenSignature(opts: {
  rawBody: Buffer | undefined;
  header: string | undefined;
  secret: string | null;
}): FastenSigStatus {
  if (!opts.secret) return "no_secret";
  if (!opts.rawBody || opts.rawBody.length === 0) return "missing";
  const { timestamp, v1 } = parseSignatureHeader(opts.header);
  if (!timestamp || !v1) return "missing";

  const skew = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (skew > TOLERANCE_SECONDS) return "stale";

  const signedPayload = `${timestamp}.${opts.rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", opts.secret).update(signedPayload).digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  if (a.length !== b.length) return "bad_signature";
  return crypto.timingSafeEqual(a, b) ? "ok" : "bad_signature";
}
