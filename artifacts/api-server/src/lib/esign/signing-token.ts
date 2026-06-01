/**
 * Stateless signing-link tokens.
 *
 * The claimant is texted a same-origin link (`/sign/<token>`) after their
 * e-sign packet is sent. The token is a short-lived HS256 JWT that encodes ONLY
 * the lead id (no PII) and a fixed purpose, signed with SESSION_SECRET — so the
 * link needs no database row and cannot be reused for anything but resolving a
 * fresh signer URL for that lead's pending envelopes. The /sign route always
 * regenerates a brand-new provider signer URL on each tap, so a stale token
 * never leaks a live signing session — it only re-identifies the lead.
 */
import jwt from "jsonwebtoken";

const PURPOSE = "esign_sign";

function signingSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length > 0) return s;
  if ((process.env.NODE_ENV ?? "development") === "development") {
    return "dev-insecure-session-secret-change-me";
  }
  throw new Error("FATAL: SESSION_SECRET is required to mint/verify e-sign signing tokens");
}

export function mintSigningToken(leadId: number, ttlDays = 30): string {
  return jwt.sign({ lead_id: leadId, purpose: PURPOSE }, signingSecret(), {
    algorithm: "HS256",
    expiresIn: `${ttlDays}d`,
  });
}

export function verifySigningToken(token: string): { leadId: number } | null {
  try {
    const decoded = jwt.verify(token, signingSecret(), { algorithms: ["HS256"] }) as {
      lead_id?: number;
      purpose?: string;
    };
    if (decoded?.purpose !== PURPOSE || typeof decoded.lead_id !== "number") return null;
    return { leadId: decoded.lead_id };
  } catch {
    return null;
  }
}

/**
 * Best-effort public base URL for links the worker texts (no request object in
 * the worker). Prefers an explicit env override, then the first Replit domain,
 * then the production custom domain.
 */
export function getPublicBaseUrl(): string {
  const explicit = process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const domains = (process.env.REPLIT_DOMAINS || "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  if (domains.length > 0) return `https://${domains[0]}`;
  return "https://mtosvelocity.com";
}
