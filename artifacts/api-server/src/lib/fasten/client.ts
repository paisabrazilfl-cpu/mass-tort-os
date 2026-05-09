/**
 * Fasten Connect API client (hosted SaaS backend).
 *
 * Reads credentials from the integrations vault row whose `provider="fasten_connect"`.
 * Required fields on the integration row:
 *   - api_url        plaintext, default https://api.connect.fastenhealth.com
 *   - client_id      vault: the public id from the Developer Portal (public_test_… / public_live_…)
 *   - api_key        vault: the private key from the Developer Portal (private_test_… / private_live_…)
 *   - client_secret  vault: webhook signing secret (the value Fasten prints once when you create a webhook)
 *
 * If no integration row is configured (typical pre-launch state), every
 * function in this module throws FastenNotConfiguredError. Callers must
 * surface that as a 503 / "configure Fasten in Settings → Integrations"
 * UI message rather than a generic 500.
 *
 * Endpoints documented at https://docs.connect.fastenhealth.com/llms.txt
 */
import { logger } from "../logger";
import { getIntegrationCredentials, type DecryptedCredentials } from "../../routes/integrations";

const DEFAULT_API_BASE = "https://api.connect.fastenhealth.com";
const PROVIDER_KEY = "fasten_connect";

export class FastenNotConfiguredError extends Error {
  readonly code = "FASTEN_NOT_CONFIGURED" as const;
  constructor() {
    super(
      "Fasten Connect integration is not configured. Add a 'fasten_connect' integration in Settings → Integrations with public_id, private_key, and webhook signing secret.",
    );
    this.name = "FastenNotConfiguredError";
  }
}

export class FastenApiError extends Error {
  readonly code = "FASTEN_API_ERROR" as const;
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = "FastenApiError";
  }
}

interface FastenCredentials {
  baseUrl: string;
  publicId: string;
  privateKey: string;
  webhookSecret: string | null;
}

async function loadCredentials(): Promise<FastenCredentials> {
  const creds: DecryptedCredentials | null = await getIntegrationCredentials(PROVIDER_KEY);
  if (!creds) throw new FastenNotConfiguredError();
  if (!creds.client_id || !creds.api_key) {
    throw new FastenNotConfiguredError();
  }
  return {
    baseUrl: (creds.api_url || DEFAULT_API_BASE).replace(/\/+$/, ""),
    publicId: creds.client_id,
    privateKey: creds.api_key,
    webhookSecret: creds.client_secret || null,
  };
}

/**
 * True if the operator has configured Fasten Connect. Cheap check used by
 * the lead-detail card to decide whether to show "Connect Records" or
 * "Configure Fasten first".
 */
export async function isFastenConnectConfigured(): Promise<boolean> {
  try {
    await loadCredentials();
    return true;
  } catch {
    return false;
  }
}

/** Webhook signing secret if configured, else null. */
export async function getFastenWebhookSecret(): Promise<string | null> {
  try {
    const c = await loadCredentials();
    return c.webhookSecret;
  } catch {
    return null;
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { authMode?: "private" | "public" } = {},
): Promise<T> {
  const c = await loadCredentials();
  const url = `${c.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const auth =
    init.authMode === "public"
      ? { "X-Public-ID": c.publicId }
      : { Authorization: `Bearer ${c.privateKey}`, "X-Public-ID": c.publicId };

  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...auth,
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      try {
        body = await res.text();
      } catch {
        /* swallow */
      }
    }
    logger.warn({ url, status: res.status, body }, "Fasten Connect API non-2xx");
    throw new FastenApiError(`Fasten Connect ${res.status} on ${path}`, res.status, body);
  }

  // Some endpoints return 204 / empty body
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public client surface — minimal, what the integration actually needs.
// ─────────────────────────────────────────────────────────────────────────────

export interface CatalogBrand {
  id: string;
  name: string;
  portal_name?: string;
  portal_id?: string;
  brand_type?: string;
  fhir_endpoint?: string;
  logo?: string | null;
}

/**
 * Search the provider catalog. Used by the operator UI when sending a
 * connect link so the patient lands on the right portal directly.
 */
export async function searchCatalog(query: string, limit = 25): Promise<CatalogBrand[]> {
  const params = new URLSearchParams({ query, limit: String(limit) });
  return request<CatalogBrand[]>(`/v1/catalog/search?${params.toString()}`);
}

export interface ConnectUrlResult {
  /** Signed URL the patient is redirected to (their provider's Patient Portal). */
  url: string;
  /** Opaque state value Fasten generated; we persist it on the connection row. */
  state: string;
}

/**
 * Generate a connect URL for a patient × provider pair. The redirect_uri
 * must match what was registered in the Developer Portal.
 */
export async function createConnectUrl(opts: {
  brandId: string;
  redirectUri: string;
  /** Per-patient identifier we send to Fasten so its webhook can correlate
   *  back to our lead row. Round-trips in the webhook payload. */
  externalId: string;
}): Promise<ConnectUrlResult> {
  return request<ConnectUrlResult>(`/v1/bridge/connect`, {
    method: "POST",
    body: JSON.stringify({
      brand_id: opts.brandId,
      redirect_uri: opts.redirectUri,
      external_id: opts.externalId,
    }),
  });
}

export interface OrgConnectionStatus {
  org_connection_id: string;
  status: "pending" | "active" | "reauth" | "revoked" | "error" | string;
  fhir_endpoint?: string;
  brand?: CatalogBrand;
  external_id?: string;
}

/** Get the current status of a previously-created org connection. */
export async function getOrgConnection(orgConnectionId: string): Promise<OrgConnectionStatus> {
  return request<OrgConnectionStatus>(
    `/v1/organization-connection/${encodeURIComponent(orgConnectionId)}`,
  );
}

export interface BulkExportTask {
  task_id: string;
  status: "pending" | "in_progress" | "completed" | "failed" | string;
  files?: Array<{ file_id: string; resource_type?: string; size?: number }>;
}

/**
 * Kick off (or fetch existing) bulk EHI export for a given org connection.
 * Idempotent — re-calling with the same org_connection_id returns the existing task.
 */
export async function startBulkExport(orgConnectionId: string): Promise<BulkExportTask> {
  return request<BulkExportTask>(`/v1/ehi-export`, {
    method: "POST",
    body: JSON.stringify({ org_connection_id: orgConnectionId }),
  });
}

/** Poll an EHI export task until completion. */
export async function getBulkExport(taskId: string): Promise<BulkExportTask> {
  return request<BulkExportTask>(`/v1/ehi-export/${encodeURIComponent(taskId)}`);
}

/**
 * Download a single file from a completed EHI export.
 * Returns the raw bytes so the caller can persist them to the vault verbatim
 * (FHIR NDJSON bundles in Fasten's case).
 */
export async function downloadBulkExportFile(opts: {
  taskId: string;
  fileId: string;
}): Promise<{ bytes: Uint8Array; contentType: string }> {
  const c = await loadCredentials();
  const url = `${c.baseUrl}/v1/ehi-export/${encodeURIComponent(
    opts.taskId,
  )}/file/${encodeURIComponent(opts.fileId)}`;
  // Endpoint returns 302 to a signed URL; let fetch follow the redirect.
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${c.privateKey}`,
      "X-Public-ID": c.publicId,
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new FastenApiError(
      `Fasten Connect download ${res.status}`,
      res.status,
      await res.text().catch(() => null),
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    bytes: buf,
    contentType: res.headers.get("content-type") || "application/fhir+ndjson",
  };
}
