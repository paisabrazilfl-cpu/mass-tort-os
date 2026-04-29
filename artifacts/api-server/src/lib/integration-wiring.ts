/**
 * Single source of truth for which preset integrations actually have a
 * working API call-out adapter wired into this build.
 *
 *   "live"           — There is real adapter code that calls the third-party
 *                      API AND that adapter consumes credentials saved in
 *                      the integrations vault.
 *
 *   "live_no_vault"  — The provider's feature works in this build, but the
 *                      adapter does NOT consume credentials saved in the
 *                      integrations vault. Today this only applies to the
 *                      Anthropic preset: AI features (extraction, OCR,
 *                      drafting) are powered by the Replit AI Integrations
 *                      SDK, which manages its own auth via environment
 *                      variables. Saving an Anthropic api_key in the vault
 *                      has no effect — the SDK ignores it. We still report
 *                      this as "wired" because the underlying feature
 *                      works, but we are explicit that the vault entry is
 *                      decorative for this provider.
 *
 *   "vault_only"     — The provider has a preset in the integrations admin
 *                      page (so an operator can save credentials), but no
 *                      code in this build ever loads those credentials and
 *                      calls the provider's API. Saving credentials for
 *                      these providers has no effect on workflows yet.
 *
 * Update this registry whenever a new adapter ships — for example, when
 * adding lib/sms/twilio.ts you'd add { status: "live", note: "..." } for
 * the "twilio" provider key.
 *
 * Sourced from (audit performed pre-migration):
 *   - lib/email/sendgrid.ts          → sendgrid
 *   - lib/esign/index.ts ADAPTERS    → docusign, dropbox_sign
 *   - lib/fax/index.ts ADAPTERS      → telnyx_fax
 *   - lib/lead-webhook-dispatcher.ts → n8n, zapier, make (type=automation)
 *   - lib/ai-{extract,fields,ocr}.ts,
 *     lib/drafting-ai.ts             → anthropic (live_no_vault — SDK auth)
 *
 * Local-only validators (address-validator, email-validator,
 * background-check via CourtListener) are NOT integration providers in
 * the preset catalog — they don't appear here.
 *
 * Drift protection:
 *   At module load time we cross-check this REGISTRY against the actual
 *   adapter maps in lib/email/sendgrid.ts, lib/esign/index.ts, and
 *   lib/fax/index.ts. If a real adapter ships without a corresponding
 *   "live" entry here (or vice-versa) the server fails fast at boot —
 *   the UI cannot silently mislead operators about what is wired.
 */

import { listEmailProviders } from "./email/sendgrid";
import { listEsignProviders } from "./esign";
import { listFaxProviders } from "./fax";

export type WiringStatus = "live" | "live_no_vault" | "vault_only";

export interface WiringInfo {
  status: WiringStatus;
  /** Human-readable note shown in admin UI. Null when no extra context. */
  note: string | null;
}

const REGISTRY: Record<string, WiringInfo> = {
  // Email
  sendgrid: {
    status: "live",
    note: "Sends transactional email via SendGrid v3 mail/send API.",
  },

  // E-Signature
  docusign: {
    status: "live",
    note: "Sends e-signature envelopes via DocuSign eSignature REST API.",
  },
  dropbox_sign: {
    status: "live",
    note: "Sends e-signature envelopes via Dropbox Sign (HelloSign) API.",
  },

  // Fax
  telnyx_fax: {
    status: "live",
    note: "Sends faxes via Telnyx Programmable Fax API.",
  },

  // Automation — receive lead.created events
  n8n: {
    status: "live",
    note: "Receives lead.created webhook events. Set api_key to enable HMAC-SHA256 signing (X-MTOS-Signature).",
  },
  zapier: {
    status: "live",
    note: "Receives lead.created webhook events. Set api_key to enable HMAC-SHA256 signing.",
  },
  make: {
    status: "live",
    note: "Receives lead.created webhook events. Set api_key to enable HMAC-SHA256 signing.",
  },

  // AI / LLM — used via Replit AI Integrations SDK (env auth, NOT the vault)
  anthropic: {
    status: "live_no_vault",
    note: "Powers AI extraction, OCR, and drafting via the Replit AI Integrations SDK. Credentials saved here are NOT consumed — the SDK manages auth itself.",
  },
};

const DEFAULT_VAULT_ONLY: WiringInfo = {
  status: "vault_only",
  note: null,
};

export function getWiring(provider: string): WiringInfo {
  return REGISTRY[provider] ?? DEFAULT_VAULT_ONLY;
}

/**
 * True if the provider has working adapter code in this build, regardless
 * of whether vault credentials are consumed. Both "live" and "live_no_vault"
 * count — the operator can rely on the feature actually firing.
 */
export function isWired(provider: string): boolean {
  const status = REGISTRY[provider]?.status;
  return status === "live" || status === "live_no_vault";
}

/**
 * True if saving credentials for this provider in the integrations vault
 * has any effect on this build. False for "live_no_vault" (e.g. Anthropic
 * via the Replit AI SDK) and for "vault_only" providers (no adapter at
 * all). Used by the /test endpoint to avoid claiming that decrypted creds
 * "will be used by workflow handlers" when they won't be.
 */
export function consumesVaultCredentials(provider: string): boolean {
  return REGISTRY[provider]?.status === "live";
}

/** All provider keys with a live adapter (vault-consuming or SDK-managed). */
export function listWiredProviders(): string[] {
  return Object.keys(REGISTRY).filter((k) => {
    const s = REGISTRY[k].status;
    return s === "live" || s === "live_no_vault";
  });
}

/**
 * Cross-check the hand-maintained REGISTRY against the actual adapter maps
 * shipped in lib/{email,esign,fax}/. Throws if there is drift. Called at
 * module load so a mis-configured build fails fast at boot rather than
 * silently lying to operators in the integrations admin UI.
 *
 * Exported so tests can call it directly with a clear error message.
 */
export function assertWiringRegistryConsistency(): void {
  const errors: string[] = [];

  // Provider classes that DO consume vault credentials (status === "live").
  // For each class, the set of providers in REGISTRY[status=live] must
  // equal the set of provider keys in the corresponding ADAPTERS map.
  const checks: Array<{ klass: string; adapterProviders: string[]; expectInRegistry: string[] }> = [
    {
      klass: "email",
      adapterProviders: listEmailProviders(),
      expectInRegistry: ["sendgrid"],
    },
    {
      klass: "esign",
      adapterProviders: listEsignProviders(),
      expectInRegistry: ["docusign", "dropbox_sign"],
    },
    {
      klass: "fax",
      adapterProviders: listFaxProviders(),
      expectInRegistry: ["telnyx_fax"],
    },
  ];

  for (const { klass, adapterProviders, expectInRegistry } of checks) {
    // Every provider in the live ADAPTERS map must be marked "live" in REGISTRY.
    for (const p of adapterProviders) {
      const w = REGISTRY[p];
      if (!w) {
        errors.push(
          `[${klass}] adapter "${p}" exists in code but has no entry in integration-wiring REGISTRY — operators will see it as "vault only" in the admin UI.`,
        );
      } else if (w.status !== "live") {
        errors.push(
          `[${klass}] adapter "${p}" exists in code but is marked "${w.status}" in REGISTRY — should be "live" because it consumes vault credentials.`,
        );
      }
    }
    // And every provider that REGISTRY claims is "live" for this class must actually exist as an adapter.
    for (const p of expectInRegistry) {
      if (!adapterProviders.includes(p)) {
        errors.push(
          `[${klass}] REGISTRY claims "${p}" is live, but it is missing from the ${klass} ADAPTERS map. Either add the adapter or change REGISTRY status.`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `integration-wiring REGISTRY is out of sync with shipped adapters:\n  - ${errors.join("\n  - ")}`,
    );
  }
}

// Run the check at module load. If it throws, the API server will refuse
// to boot — which is exactly what we want, because the alternative is the
// integrations admin page silently mis-reporting wiring status.
assertWiringRegistryConsistency();
