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
 *   - api_key        vault: an admin API token issued by the fasten-onprem instance
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
      "Fasten on-prem integration is not configured. Add a 'fasten_onprem' integration in Settings → Integrations with api_url and an admin api_key.",
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
  apiKey: string;
}

async function loadOnpremCredentials(): Promise<OnpremCreds> {
  const creds: DecryptedCredentials | null = await getIntegrationCredentials(PROVIDER_KEY);
  if (!creds || !creds.api_url || !creds.api_key) {
    throw new FastenOnpremNotConfiguredError();
  }
  return {
    baseUrl: creds.api_url.replace(/\/+$/, ""),
    apiKey: creds.api_key,
  };
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
  const c = await loadOnpremCredentials();
  const url = `${c.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${c.apiKey}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
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
