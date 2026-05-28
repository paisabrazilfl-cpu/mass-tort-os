/**
 * Backend-selecting facade. The rest of the codebase imports from
 * `lib/fasten` and never touches `client.ts` / `onprem.ts` directly — that
 * way swapping a connection between the hosted Connect API and the self-
 * hosted fasten-onprem instance is a one-row change in the connection row,
 * not a code refactor.
 */
import { logger } from "../logger";
import * as connect from "./client";
import * as onprem from "./onprem";

export type FastenBackend = "connect" | "onprem";

export {
  FastenNotConfiguredError,
  FastenApiError,
  type CatalogBrand,
  type ConnectUrlResult,
  type OrgConnectionStatus,
  type BulkExportTask,
} from "./client";
export {
  FastenOnpremNotConfiguredError,
  FastenOnpremApiError,
} from "./onprem";

export async function isAnyBackendConfigured(): Promise<{
  connect: boolean;
  onprem: boolean;
  any: boolean;
}> {
  const [c, o] = await Promise.all([
    connect.isFastenConnectConfigured(),
    onprem.isFastenOnpremConfigured(),
  ]);
  return { connect: c, onprem: o, any: c || o };
}

/**
 * Issue a connect URL on whichever backend the caller requested.
 * Falls back automatically: if `backend === "connect"` is unconfigured but
 * onprem is, the operator gets a clear error rather than a silent fallback
 * that would surprise them.
 */
export async function createConnectUrl(opts: {
  backend: FastenBackend;
  brandId: string; // ignored for onprem (its UI handles brand selection)
  redirectUri: string;
  externalId: string;
}): Promise<{ url: string; state: string; backend: FastenBackend }> {
  if (opts.backend === "onprem") {
    const r = await onprem.createOnpremConnectUrl({
      redirectUri: opts.redirectUri,
      externalId: opts.externalId,
    });
    return { ...r, backend: "onprem" };
  }
  const r = await connect.createConnectUrl({
    brandId: opts.brandId,
    redirectUri: opts.redirectUri,
    externalId: opts.externalId,
  });
  return { ...r, backend: "connect" };
}

/**
 * Trigger a sync of all FHIR records for a given connection.
 * Returns either:
 *   - { kind: "bulk_task", taskId, files } for the hosted Connect API
 *     (caller should enqueue a fasten_records_sync job to poll + download)
 *   - { kind: "fhir_bundle", bundle } for on-prem (one-shot fetch, ready
 *     to hand straight to the ingest function)
 */
export async function startSync(opts: {
  backend: FastenBackend;
  orgConnectionId: string;
}): Promise<
  | { kind: "bulk_task"; taskId: string; status: string }
  | { kind: "fhir_bundle"; bundle: unknown }
> {
  if (opts.backend === "onprem") {
    const bundle = await onprem.fetchOnpremPatientEverything(opts.orgConnectionId);
    return { kind: "fhir_bundle", bundle };
  }
  const task = await connect.startBulkExport(opts.orgConnectionId);
  return { kind: "bulk_task", taskId: task.task_id, status: task.status };
}

/** Convenience: log + swallow "not configured" errors so the lead-detail
 *  card never crashes the page just because nobody has set up Fasten yet. */
export async function safeIsConfigured(): Promise<boolean> {
  try {
    const { any } = await isAnyBackendConfigured();
    return any;
  } catch (err) {
    logger.warn({ err }, "fasten safeIsConfigured() threw — treating as not configured");
    return false;
  }
}

// Re-export low-level clients for routes/worker that need fine-grained access.
export { connect, onprem };
