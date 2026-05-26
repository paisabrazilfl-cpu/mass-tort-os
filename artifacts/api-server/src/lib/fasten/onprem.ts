/**
 * Self-hosted fasten-onprem adapter.
 *
 * Talks to a Fasten On-Premise instance you run yourself
 * (https://github.com/fastenhealth/fasten-onprem). The on-prem build is
 * GPL-3.0 and free to self-host but does NOT have access to the hosted
 * Connect catalog — patients can only connect to providers fasten-onprem
 * supports out of the box (a smaller set than Connect's 60k+).
 *
 * Reads credentials from the integrations vault row whose `provider="fasten_onprem"`.
 * Required fields:
 *   - api_url        plaintext, e.g. https://fasten.your-domain.com
 *   - api_key        vault: admin password for the fasten-onprem instance
 *   - client_id      vault: admin username (defaults to "admin" if omitted)
 *
 * The client signs in automatically before each API call, caching the JWT
 * in memory and refreshing it 5 minutes before expiry.
 *
 * Use FASTEN_BACKEND=onprem (or set the per-integration backend) to route
 * connections through this adapter instead of the hosted Connect API.
 */
import { logger } from "../logger";
import { getIntegrationCredentials, type DecryptedCredentials } from "../../routes/integrations";

const PROVIDER_KEY = "fasten_onprem";

export class FastenOnpremNotConfiguredError extends Error {
  readonly code = "FASTEN_ONPREM_NOT_CONFIGURED" as const;
  constructor() {
    super(
      "Fasten on-prem integration is not configured. Add a 'fasten_onprem' integration in Settings → Integrations with api_url and api_key (admin password).",
    );
    this.name = "FastenOnpremNotConfiguredError";
  }
}

export class FastenOnpremApiError extends Error {
  readonly code = "FASTEN_ONPREM_API_ERROR" as const;
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "FastenOnpremApiError";
  }
}

interface OnpremCreds {
  baseUrl: string;
  username: string;
  password: string;
}

// In-memory JWT cache — keyed by baseUrl so it survives across requests
// within the same process lifetime without re-authenticating on every call.
const jwtCache = new Map<string, { token: string; exp: number }>();

async function loadOnpremCredentials(): Promise<OnpremCreds> {
  const creds: DecryptedCredentials | null = await getIntegrationCredentials(PROVIDER_KEY);
  if (!creds || !creds.api_url || !creds.api_key) {
    throw new FastenOnpremNotConfiguredError();
  }
  return {
    baseUrl: creds.api_url.replace(/\/+$/, ""),
    username: creds.client_id || "admin",
    password: creds.api_key,
  };
}

/** Get a valid JWT, signing in if the cached one is missing or near expiry. */
async function getJwt(creds: OnpremCreds): Promise<string> {
  const cached = jwtCache.get(creds.baseUrl);
  const now = Math.floor(Date.now() / 1000);
  // Refresh if missing or expiring within 5 minutes
  if (cached && cached.exp > now + 300) {
    return cached.token;
  }

  const res = await fetch(`${creds.baseUrl}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username: creds.username, password: creds.password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as any;
    throw new FastenOnpremApiError(
      `fasten-onprem signin failed (${res.status}): ${body?.error || "unknown"}`,
      res.status,
    );
  }

  const data = await res.json() as { data?: string; success?: boolean };
  const token = data.data;
  if (!token) throw new FastenOnpremApiError("fasten-onprem signin returned no token", 500);

  // Decode expiry from JWT payload (no verification needed — server just issued it)
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    jwtCache.set(creds.baseUrl, { token, exp: payload.exp ?? now + 3600 });
  } catch {
    jwtCache.set(creds.baseUrl, { token, exp: now + 3500 });
  }

  logger.info({ baseUrl: creds.baseUrl }, "fasten-onprem: refreshed admin JWT");
  return token;
}

export async function isFastenOnpremConfigured(): Promise<boolean> {
  try {
    await loadOnpremCredentials();
    return true;
  } catch {
    return false;
  }
}

async function onpremRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const creds = await loadOnpremCredentials();
  const jwt = await getJwt(creds);
  const url = `${creds.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    // If the token was just refreshed and still 401, clear cache and throw
    if (res.status === 401) jwtCache.delete(creds.baseUrl);
    logger.warn({ url, status: res.status }, "fasten-onprem API non-2xx");
    throw new FastenOnpremApiError(`fasten-onprem ${res.status} on ${path}`, res.status);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

/**
 * Issue a connect URL pointing at your self-hosted fasten-onprem instance.
 * The patient lands on its provider picker and authenticates there; on
 * completion fasten-onprem redirects back to redirectUri with a source_id
 * query parameter we capture as the connection handle.
 */
export async function createOnpremConnectUrl(opts: {
  redirectUri: string;
  externalId: string;
}): Promise<{ url: string; state: string }> {
  // fasten-onprem's UI does not have a programmatic "create connect URL"
  // endpoint identical to Connect's. We construct the URL the same way the
  // upstream Angular client does: /sources/connect with our state encoded
  // so the redirect can correlate back.
  const c = await loadOnpremCredentials();
  const state = Buffer.from(JSON.stringify({ ext: opts.externalId, t: Date.now() })).toString(
    "base64url",
  );
  const params = new URLSearchParams({
    redirect_uri: opts.redirectUri,
    state,
  });
  return {
    url: `${c.baseUrl}/web/sources/connect?${params.toString()}`,
    state,
  };
}

/**
 * Fetch a patient $everything FHIR Bundle for an on-prem source.
 * fasten-onprem stores resources under /api/secure/fhir/<resourceType>.
 */
export async function fetchOnpremPatientEverything(sourceId: string): Promise<unknown> {
  return onpremRequest<unknown>(
    `/api/secure/fhir/Patient/$everything?source_id=${encodeURIComponent(sourceId)}`,
  );
}

export async function getOnpremSourceStatus(
  sourceId: string,
): Promise<{ id: string; status: string; brand?: string }> {
  return onpremRequest(`/api/secure/source/${encodeURIComponent(sourceId)}`);
}
