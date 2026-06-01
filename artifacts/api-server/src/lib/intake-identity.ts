// HIPAA identity gate for the standalone intake landing pages.
//
// The public intake pages at /intake/:slug collect protected health
// information. To tie every submission to a verified human identity, the
// page can require the visitor to sign in with Google (Google Identity
// Services) BEFORE the intake form is revealed. The browser obtains a Google
// ID token (a signed JWT) and forwards it with the submission; this module
// verifies that token server-side against Google's public keys.
//
// The gate is a deploy-time switch: it is ENABLED whenever a Google OAuth
// web client id is configured via the GOOGLE_OAUTH_CLIENT_ID environment
// variable, and OFF otherwise. This keeps existing ungated deployments
// working until the owner provisions an OAuth client id, at which point the
// gate activates everywhere automatically. There is no silent bypass: when
// the gate is enabled, a missing or invalid token is a hard rejection.

import { OAuth2Client } from "google-auth-library";
import { logger } from "./logger";

export function getGoogleClientId(): string | null {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  return id && id.length > 0 ? id : null;
}

/** True when the HIPAA Google sign-in gate is active for intake pages. */
export function isIntakeIdentityGateEnabled(): boolean {
  return getGoogleClientId() !== null;
}

let cachedClient: { id: string; client: OAuth2Client } | null = null;
function clientFor(clientId: string): OAuth2Client {
  if (!cachedClient || cachedClient.id !== clientId) {
    cachedClient = { id: clientId, client: new OAuth2Client(clientId) };
  }
  return cachedClient.client;
}

export interface VerifiedIdentity {
  email: string;
  emailVerified: boolean;
  sub: string;
  name?: string;
}

/**
 * Verify a Google ID token (the `credential` returned by Google Identity
 * Services). Returns the verified identity, or null on any failure. The
 * google-auth-library `verifyIdToken` checks the JWT signature against
 * Google's published keys and validates the audience (our client id),
 * issuer, and expiry — so no client secret is required for verification.
 */
export async function verifyGoogleIdToken(
  idToken: unknown,
): Promise<VerifiedIdentity | null> {
  const clientId = getGoogleClientId();
  if (!clientId) return null;
  if (typeof idToken !== "string" || idToken.length === 0) return null;
  try {
    const ticket = await clientFor(clientId).verifyIdToken({
      idToken,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) return null;
    return {
      email: payload.email ?? "",
      emailVerified: Boolean(payload.email_verified),
      sub: payload.sub,
      name: payload.name,
    };
  } catch (err) {
    logger.warn({ err }, "Google ID token verification failed");
    return null;
  }
}
