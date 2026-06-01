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
 *   - lib/fax/index.ts ADAPTERS      → srfax
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

import { listEmailProviders } from "./email";
import { listEsignProviders } from "./esign";
import { listFaxProviders } from "./fax";
import { listSmsProviders } from "./sms";
import { listVoiceProviders } from "./voice";
import { listLlmProviders } from "./ai";
import { listSearchProviders } from "./search";
import { PRESET_INTEGRATIONS } from "./integration-presets";

/**
 * For each "live" provider, the credential field names the adapter actually
 * reads from `creds` at call time. The preset's `fields` array MUST be a
 * superset of this list — otherwise the integrations admin form will never
 * prompt the operator for a field the adapter requires, and every workflow
 * call will fail with "missing X" no matter how cleanly credentials decrypt.
 *
 * This is a stronger invariant than the adapter-existence check below: it
 * caught a real bug where the docusign preset declared
 * ["api_key","client_id","client_secret","api_url"] but the adapter reads
 * ["api_key","account_sid"]. The form prompted for the wrong fields and
 * every Send-for-signature attempt failed before leaving the adapter.
 *
 * Update this map whenever an adapter changes which credential keys it
 * pulls off `creds`. Keep it in sync with the actual `creds.<field>` reads
 * in lib/{email,esign,fax}/<provider>.ts.
 */
const ADAPTER_REQUIRED_FIELDS: Record<string, string[]> = {
  // Email
  sendgrid: ["api_key"],
  postmark: ["api_key"],
  resend: ["api_key"],
  mailgun: ["api_key"],
  aws_ses: ["api_key", "client_secret"],
  brevo: ["api_key"],

  // E-Signature
  docusign: ["api_key", "account_sid"],
  dropbox_sign: ["api_key"],

  // Fax
  srfax: ["access_id", "access_password", "fax_number"],
  efax: ["api_key"],
  phaxio: ["api_key", "client_secret"],
  documo: ["api_key"],
  telnyx_fax: ["api_key"],

  // SMS — providers whose inbound webhook verifier reads `client_secret`
  // (HMAC-SHA256 signing key) MUST require it here so operators can't mark
  // the integration "Live" while signature verification is impossible.
  twilio: ["api_key", "account_sid"],
  telnyx: ["api_key", "client_secret"],
  bandwidth: ["api_key", "client_secret"],
  plivo: ["api_key", "account_sid"],
  messagebird: ["api_key", "client_secret"],
  sinch: ["api_key", "client_secret"],

  // Voice AI — same invariant: any provider whose inbound /webhooks/voice
  // verifier reads `client_secret` requires it. vapi already used api_key
  // for HMAC + client_secret as the tool-call bearer.
  vapi: ["api_key", "client_secret"],
  retell_ai: ["api_key", "client_secret"],
  bland_ai: ["api_key", "client_secret"],
  elevenlabs: ["api_key", "client_secret"],
  synthflow: ["api_key", "client_secret"],

  // Phone Validation & Fraud — Twilio Lookup v2 adapter
  // (lib/bg-hub/phone-provenance.ts) authenticates with HTTP Basic using
  // account_sid + the auth token stored in api_key.
  twilio_lookup: ["account_sid", "api_key"],

  // Medical Records — Fasten Health (patient-initiated FHIR aggregation).
  // The Connect adapter reads all three secret fields: client_id (public id),
  // api_key (private key), client_secret (webhook signing secret). The on-prem
  // adapter only needs api_key (the admin token for your self-hosted instance).
  fasten_connect: ["api_key", "client_id", "client_secret"],
  fasten_onprem: ["api_key"],

  // AI / LLM (vault-consuming providers — anthropic/openai are env-managed)
  google_gemini: ["api_key"],
  openrouter: ["api_key"],
  groq: ["api_key"],
  deepseek: ["api_key"],
  perplexity: ["api_key"],
  mistral: ["api_key"],
  cohere: ["api_key"],
  xai_grok: ["api_key"],
  fireworks_ai: ["api_key"],

  // Web Search
  serpapi: ["api_key"],

  // Court Records — PACER PCL Search API. api_key=PACER username,
  // client_secret=PACER password (mapped this way so the existing preset
  // field taxonomy covers it without introducing new field names).
  pacer: ["api_key", "client_secret"],
};

export type WiringStatus = "live" | "live_no_vault" | "vault_only";

export interface WiringInfo {
  status: WiringStatus;
  /** Human-readable note shown in admin UI. Null when no extra context. */
  note: string | null;
}

const REGISTRY: Record<string, WiringInfo> = {
  // Email
  sendgrid: { status: "live", note: "Sends transactional email via SendGrid v3 mail/send API." },
  postmark: { status: "live", note: "Sends transactional email via Postmark email API." },
  resend: { status: "live", note: "Sends transactional email via Resend email API." },
  mailgun: { status: "live", note: "Sends transactional email via Mailgun v3 messages API. Requires config.domain." },
  aws_ses: { status: "live", note: "Sends transactional email via AWS SES v2 (SigV4-signed). Requires config.region." },
  brevo: { status: "live", note: "Sends transactional email via Brevo v3 SMTP API." },

  // E-Signature
  docusign: { status: "live", note: "Sends e-signature envelopes via DocuSign eSignature REST API." },
  dropbox_sign: { status: "live", note: "Sends e-signature envelopes via Dropbox Sign (HelloSign) API." },

  // Fax
  srfax: { status: "live", note: "Sends faxes via SRFax JSON API (HIPAA-compliant, healthcare focused)." },
  efax: { status: "live", note: "Sends faxes via eFax Developer REST API." },
  phaxio: { status: "live", note: "Sends faxes via Phaxio (Sinch) v2.1 API. Requires api_key + client_secret." },
  documo: { status: "live", note: "Sends faxes via Documo (mFax) v1 API." },
  telnyx_fax: { status: "live", note: "Sends faxes via Telnyx Programmable Fax v2. Requires config.connection_id." },

  // SMS
  twilio: { status: "live", note: "Sends SMS via Twilio Programmable Messaging. Requires account_sid + auth token (api_key) + config.from_number." },
  telnyx: { status: "live", note: "Sends SMS via Telnyx v2 messages API. client_secret carries Ed25519 webhook public key." },
  bandwidth: { status: "live", note: "Sends SMS via Bandwidth Messaging v2. Requires api_key=user:secret + config.account_id/application_id/from_number." },
  plivo: { status: "live", note: "Sends SMS via Plivo Message API. Requires account_sid + auth token (api_key) + config.from_number." },
  messagebird: { status: "live", note: "Sends SMS via Bird (MessageBird) REST API. Requires config.from_number." },
  sinch: { status: "live", note: "Sends SMS via Sinch XMS batches. Requires config.service_plan_id + from_number; optional config.region (us/eu)." },

  // Voice AI
  vapi: { status: "live", note: "Voice AI agent via Vapi REST API + signed webhooks." },
  retell_ai: { status: "live", note: "Voice AI agent via Retell AI list-agents + REST API." },
  bland_ai: { status: "live", note: "Voice AI agent via Bland AI v1 pathway API." },
  elevenlabs: { status: "live", note: "Voice AI agent via ElevenLabs Conversational + voices APIs." },
  synthflow: { status: "live", note: "Voice AI agent via Synthflow v2 assistants API." },

  // Phone Validation & Fraud — line-type/carrier/SIM-swap intelligence.
  // The adapter lives in lib/bg-hub/phone-provenance.ts and feeds the
  // Background Check Hub "phone" lane (VoIP/prepaid filtering in lead intake).
  // Like pacer/serpapi/fasten above, this is a real vault-consuming adapter
  // that is NOT registered in the email/esign/fax/sms/voice/llm ADAPTERS maps,
  // so assertWiringRegistryConsistency does not cross-check it.
  twilio_lookup: {
    status: "live",
    note: "Phone line-type, carrier, and SIM-swap intelligence via Twilio Lookup v2 (lookups.twilio.com). Feeds the Background Check Hub phone lane to flag VoIP/non-genuine numbers in lead intake. Requires account_sid + auth token (api_key).",
  },

  // Web Search
  serpapi: { status: "live", note: "Google/Bing/Yahoo search results as structured JSON via SerpAPI /search.json. Requires api_key." },

  // Court Records
  pacer: {
    status: "live",
    note: "Federal court searches via PACER PCL Search API (lib/pacer/pcl-client.ts). Powers the dedicated 'pacer_federal' lane in the Background Check Hub. Requires api_key=PACER username + client_secret=PACER password. Per-page billing applies on the PACER side.",
  },

  // AI / LLM (vault-consuming providers)
  bitdeer: { status: "live", note: "LLM completions, vision, embeddings, and image generation via Bitdeer AI Cloud OpenAI-compatible API (api-inference.bitdeer.ai/v1). Primary LLM provider for MTOS." },
  google_gemini: { status: "live", note: "LLM completions via Gemini v1beta generateContent." },
  openrouter: { status: "live", note: "LLM completions via OpenRouter unified chat completions API." },
  groq: { status: "live", note: "LLM completions via Groq /openai/v1/chat/completions." },
  deepseek: { status: "live", note: "LLM completions via DeepSeek v1 chat completions." },
  perplexity: { status: "live", note: "LLM completions via Perplexity chat completions." },
  mistral: { status: "live", note: "LLM completions via Mistral v1 chat completions." },
  cohere: { status: "live", note: "LLM completions via Cohere v2 chat." },
  xai_grok: { status: "live", note: "LLM completions via xAI Grok v1 chat completions." },
  fireworks_ai: { status: "live", note: "LLM completions via Fireworks AI inference v1 chat completions." },

  // Medical Records — Fasten Health (patient-initiated FHIR aggregation).
  // Both backends ship as live adapters: lib/fasten/client.ts (hosted Connect API)
  // and lib/fasten/onprem.ts (self-hosted GPL build). They are NOT registered
  // in any of the email/esign/fax/sms/voice/llm ADAPTERS maps, so the cross-
  // check loop in assertWiringRegistryConsistency does not validate them — but
  // they are real, vault-consuming adapters wired into routes/fasten.ts and
  // the fasten_records_sync worker job.
  fasten_connect: {
    status: "live",
    note: "Patient-initiated FHIR aggregation via Fasten Connect API. Requires client_id (public id), api_key (private key), and client_secret (webhook signing secret).",
  },
  fasten_onprem: {
    status: "live",
    note: "Self-hosted fasten-onprem GPL build. Requires api_url pointing at your instance and an admin api_key.",
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

  // AI / LLM — env-managed via Replit AI Integrations SDK (auth from env, not vault).
  // Vault credentials are accepted as overrides but the env client is used by default.
  anthropic: {
    status: "live_no_vault",
    note: "Hard fallback LLM. Uses the Replit AI Integrations SDK by default (env auth); a vault api_key is accepted as an override but is optional.",
  },
  openai: {
    status: "live_no_vault",
    note: "Default LLM. Uses the Replit AI Integrations SDK by default (env auth); a vault api_key is accepted as an override but is optional.",
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
      expectInRegistry: ["sendgrid", "postmark", "resend", "mailgun", "aws_ses", "brevo"],
    },
    {
      klass: "esign",
      adapterProviders: listEsignProviders(),
      expectInRegistry: ["docusign", "dropbox_sign"],
    },
    {
      klass: "fax",
      adapterProviders: listFaxProviders(),
      expectInRegistry: ["srfax", "efax", "phaxio", "documo", "telnyx_fax"],
    },
    {
      klass: "sms",
      adapterProviders: listSmsProviders(),
      expectInRegistry: ["twilio", "telnyx", "bandwidth", "plivo", "messagebird", "sinch"],
    },
    {
      klass: "voice",
      adapterProviders: listVoiceProviders(),
      expectInRegistry: ["vapi", "retell_ai", "bland_ai", "elevenlabs", "synthflow"],
    },
    {
      klass: "llm",
      // anthropic and openai are env-managed (live_no_vault) — they ship in
      // the LLM ADAPTERS map but the REGISTRY entry stays "live_no_vault".
      adapterProviders: listLlmProviders().filter((p) => p !== "anthropic" && p !== "openai"),
      expectInRegistry: ["google_gemini", "openrouter", "groq", "deepseek", "perplexity", "mistral", "cohere", "xai_grok", "fireworks_ai"],
    },
    {
      klass: "search",
      adapterProviders: listSearchProviders(),
      expectInRegistry: ["serpapi"],
    },
    {
      // Court records — currently a single provider (PACER PCL Search API).
      // Unlike the multi-provider classes above, the court-records space
      // uses one bespoke adapter (lib/pacer/pcl-client.ts) instead of a
      // category index. We hardcode ["pacer"] on both sides so any future
      // attempt to remove the PACER adapter without also pruning REGISTRY
      // (or vice versa) trips this consistency check at boot.
      klass: "court_records",
      adapterProviders: ["pacer"],
      expectInRegistry: ["pacer"],
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

  // Field-level drift: every credential field the adapter reads at call time
  // MUST be declared in its preset's `fields` array, otherwise the admin form
  // never prompts for it and workflows fail with "missing X" no matter how
  // cleanly the saved credentials decrypt. This was added after the docusign
  // preset/adapter mismatch shipped to production undetected — the existence
  // check above passed because docusign IS in the adapter map, but the form
  // asked for client_id/client_secret while the adapter wanted account_sid.
  for (const [provider, requiredFields] of Object.entries(ADAPTER_REQUIRED_FIELDS)) {
    const preset = PRESET_INTEGRATIONS.find((p) => p.provider === provider);
    if (!preset) {
      errors.push(
        `[fields] ADAPTER_REQUIRED_FIELDS lists "${provider}" but no preset with that key exists in integration-presets — operators have no UI path to save credentials for it.`,
      );
      continue;
    }
    const presetFields: readonly string[] = preset.fields ?? [];
    const missing = requiredFields.filter((f) => !presetFields.includes(f));
    if (missing.length > 0) {
      errors.push(
        `[fields] preset "${provider}" declares fields=[${presetFields.join(",")}] but adapter requires [${requiredFields.join(",")}] — admin form will never prompt for: ${missing.join(", ")}. Add the missing fields to the preset or change the adapter to read different keys.`,
      );
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
