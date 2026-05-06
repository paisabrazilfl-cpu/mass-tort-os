import { db, integrationsTable, workflowSettingsTable, buyersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getIntegrationCredentialsById, DecryptedCredentials } from "../routes/integrations";
import { logger } from "./logger";

export type ProviderCategory =
  | "esign"
  | "fax"
  | "email"
  | "sms"
  | "voice"
  | "llm_default"
  | "llm_drafting";

export interface ResolvedProvider {
  integration_id: number;
  provider: string;
  name: string;
  credentials: DecryptedCredentials;
}

export interface ProviderResolutionMiss {
  reason:
    | "no_settings"
    | "no_integration_configured"
    | "integration_not_found"
    | "integration_inactive"
    | "decryption_error";
  details?: string;
}

/**
 * Map a provider category → the column on workflow_settings/buyers that holds the integration FK.
 */
const FIELD_BY_CATEGORY: Record<ProviderCategory, keyof typeof workflowSettingsTable.$inferSelect> = {
  esign: "esign_provider_integration_id",
  fax: "fax_provider_integration_id",
  email: "email_provider_integration_id",
  sms: "sms_provider_integration_id",
  voice: "voice_provider_integration_id",
  llm_default: "llm_default_provider_integration_id",
  llm_drafting: "llm_drafting_provider_integration_id",
};

/**
 * Pre-existing default provider per category. When workflow_settings has
 * no FK chosen for a category, we look for an active integration row of
 * this provider so we preserve the legacy hard-wired behavior (lead SMS
 * always went through Telnyx, fax through srfax, etc) instead of failing
 * with `no_integration_configured`. Operators can override on the
 * Workflow Settings page.
 */
const DEFAULT_PROVIDER_BY_CATEGORY: Record<ProviderCategory, string | null> = {
  esign: "dropbox_sign",
  fax: "srfax",
  email: "sendgrid",
  sms: "telnyx",
  voice: "vapi",
  llm_default: null,   // ai-provider.ts handles env fallback to anthropic
  llm_drafting: null,
};

async function findActiveIntegrationByProvider(provider: string): Promise<number | null> {
  // Provider uniqueness is NOT enforced at the schema level (multiple
  // historical rows for the same provider can coexist after re-onboarding).
  // Filter by status="active" and pick the most recently created row so
  // fallback resolution is deterministic and never selects a stale/inactive
  // integration. Returns null if NO active row exists — callers then surface
  // `no_integration_configured` to the admin UI.
  const rows = await db
    .select({ id: integrationsTable.id })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.provider, provider),
        eq(integrationsTable.status, "active"),
      ),
    )
    .orderBy(desc(integrationsTable.created_at))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function getGlobalSettings() {
  const [row] = await db
    .select()
    .from(workflowSettingsTable)
    .where(eq(workflowSettingsTable.scope, "global"));
  return row || null;
}

async function getBuyerOverride(buyerId: number) {
  const [row] = await db.select().from(buyersTable).where(eq(buyersTable.id, buyerId));
  return row || null;
}

/**
 * Resolve which integration row to use for a given (category, optional buyer).
 * Resolution order:
 *   1. Buyer-level override (buyers.<category>_provider_integration_id)
 *   2. Global workflow_settings (scope="global")
 * Returns the resolved provider with decrypted credentials, OR a structured miss reason.
 *
 * NEVER throws — always returns a discriminated result so callers can decide whether
 * to fall back, queue for retry, or surface to the admin UI.
 */
export async function resolveProvider(
  category: ProviderCategory,
  opts: { buyerId?: number | null; explicitIntegrationId?: number | null } = {},
): Promise<ResolvedProvider | ProviderResolutionMiss> {
  let integrationId: number | null = null;

  if (opts.explicitIntegrationId) {
    integrationId = opts.explicitIntegrationId;
  } else {
    if (opts.buyerId) {
      const buyer = await getBuyerOverride(opts.buyerId);
      const buyerField =
        category === "esign"
          ? buyer?.esign_provider_integration_id
          : category === "fax"
          ? buyer?.fax_provider_integration_id
          : category === "email"
          ? buyer?.email_provider_integration_id
          : null; // sms/voice/llm_* have no per-buyer overrides yet — fall through to global
      if (buyerField) integrationId = buyerField;
    }

    if (!integrationId) {
      const settings = await getGlobalSettings();
      if (!settings) {
        return {
          reason: "no_settings",
          details: "Global workflow_settings row missing — initialize via the Workflow Settings page.",
        };
      }
      const field = FIELD_BY_CATEGORY[category];
      // settings is typed as workflowSettingsTable.$inferSelect; FIELD_BY_CATEGORY
      // values are constrained to keyof that type so this lookup is type-safe
      // (the cast just tells TS the indexed value's runtime shape).
      const val = (settings as Record<string, unknown>)[field as string];
      if (typeof val === "number") integrationId = val;
    }
  }

  if (!integrationId) {
    // Null FK on workflow_settings: preserve legacy default by looking
    // up an active integration row matching the category's default
    // provider. If even that is missing, fall through to the explicit
    // miss reason so the admin UI can prompt the operator.
    const defaultProvider = DEFAULT_PROVIDER_BY_CATEGORY[category];
    if (defaultProvider) {
      const found = await findActiveIntegrationByProvider(defaultProvider);
      if (found) integrationId = found;
    }
  }

  if (!integrationId) {
    return {
      reason: "no_integration_configured",
      details: `No ${category} provider chosen. Pick one from your integrations on the Workflow Settings page.`,
    };
  }

  const [row] = await db.select().from(integrationsTable).where(eq(integrationsTable.id, integrationId));
  if (!row) {
    return { reason: "integration_not_found", details: `Integration ${integrationId} no longer exists.` };
  }
  if (row.status !== "active") {
    return {
      reason: "integration_inactive",
      details: `Integration "${row.name}" is currently ${row.status}. Activate it on the Integrations page.`,
    };
  }

  const credentials = await getIntegrationCredentialsById(integrationId);
  if (!credentials) {
    return { reason: "integration_inactive", details: `Could not load credentials for "${row.name}".` };
  }
  if (credentials._decryption_errors && credentials._decryption_errors.length) {
    logger.error(
      { integration_id: integrationId, fields: credentials._decryption_errors },
      "Provider credentials failed to decrypt — likely ENCRYPTION_KEY mismatch",
    );
    return {
      reason: "decryption_error",
      details: `Credential decryption failed for fields: ${credentials._decryption_errors.join(", ")}. Re-enter the API key.`,
    };
  }

  return {
    integration_id: integrationId,
    provider: row.provider,
    name: row.name,
    credentials,
  };
}

export function isResolved(r: ResolvedProvider | ProviderResolutionMiss): r is ResolvedProvider {
  return (r as ResolvedProvider).integration_id !== undefined;
}
