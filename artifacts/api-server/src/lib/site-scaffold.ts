// Site Maker AI scaffold engine.
//
// Turns a plain tort display name + canonical category into a structured,
// REVIEWABLE proposal for a new public tort site: tort-specific custom
// eligibility/story fields, a plain-English eligibility checklist for the
// landing page, severity tiers, a statute-of-limitations hint, and SEO copy.
//
// CRITICAL CONTRACT: this engine NEVER commits anything. It only proposes.
// The output is a tri-state proposal (QUALIFIED / REVIEW / REJECTED) that an
// operator reviews and explicitly accepts in the Site Maker wizard before any
// site is created. The locked canonical guardrails (base contact fields,
// eligibility questions, anti-fraud probes, TCPA consent, base rules) are
// owned by comprehensive-tort-forms.ts and are NOT the AI's responsibility —
// the AI only proposes the tort-specific layer that sits on top.
//
// Mirrors the assist-planner pattern: callLLM (lead-intelligence module) +
// recursiveRetry perspective-shifting + strict zod validation. Any custom
// field whose key collides with a locked canonical key is dropped during
// validation so the AI can never shadow the compliance spine.

import { z } from "zod/v4";
import { callLLM } from "./ai-provider";
import { getAiConstitutionPreamble } from "./ai-constitution";
import {
  recursiveRetry,
  perspectiveCue,
  type AttemptOutcome,
  type AttemptLog,
  type StoppedReason,
} from "./automations/recursive-retry";
import { logger } from "./logger";
import {
  CANONICAL_BASE_FIELD_KEYS,
  CANONICAL_CATEGORIES,
} from "./comprehensive-tort-forms";
import { customFieldSchema, webFormFieldSchema, eligibilityRuleSchema } from "@workspace/db";
import type { CustomField, WebFormField, EligibilityRule } from "@workspace/db";

// ── Output schema ────────────────────────────────────────────────────────────

export const scaffoldDecisionSchema = z.enum(["QUALIFIED", "REVIEW", "REJECTED"]);
export type ScaffoldDecision = z.infer<typeof scaffoldDecisionSchema>;

export const scaffoldSeoSchema = z.object({
  meta_title: z.string().max(180).default(""),
  meta_description: z.string().max(400).default(""),
  keywords: z.array(z.string().max(80)).max(20).default([]),
  hero_headline: z.string().max(180).default(""),
  hero_subhead: z.string().max(400).default(""),
});
export type ScaffoldSeo = z.infer<typeof scaffoldSeoSchema>;

// The model returns a loose shape; we validate strictly and coerce.
const scaffoldRawSchema = z.object({
  decision: scaffoldDecisionSchema,
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().max(500)).max(12).default([]),
  custom_fields: z.array(webFormFieldSchema).max(20).default([]),
  eligibility_rules: z.array(eligibilityRuleSchema).max(20).default([]),
  eligibility_checklist: z.array(z.string().max(300)).max(15).default([]),
  severity_tiers: z
    .array(
      z.object({
        tier: z.string().max(60),
        description: z.string().max(300),
      }),
    )
    .max(8)
    .default([]),
  statute_hint: z.string().max(600).default(""),
  seo: scaffoldSeoSchema.default({
    meta_title: "",
    meta_description: "",
    keywords: [],
    hero_headline: "",
    hero_subhead: "",
  }),
});

export interface ScaffoldProposal {
  decision: ScaffoldDecision;
  confidence: number;
  reasons: string[];
  /** Tort-specific story/eligibility fields proposed (locked keys stripped). */
  customFields: WebFormField[];
  /** Tort-specific eligibility rules proposed (locked rule ids stripped). */
  eligibilityRules: EligibilityRule[];
  /** Plain-English bullet list for the landing page. */
  eligibilityChecklist: string[];
  severityTiers: { tier: string; description: string }[];
  statuteHint: string;
  seo: ScaffoldSeo;
}

export type ScaffoldResult =
  | {
      ok: true;
      proposal: ScaffoldProposal;
      attempts: AttemptLog[];
      stoppedReason: StoppedReason;
    }
  | {
      ok: false;
      code: string;
      message: string;
      details?: unknown;
      attempts: AttemptLog[];
      stoppedReason: Exclude<StoppedReason, "succeeded">;
    };

// ── Prompt ────────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const lockedKeys = CANONICAL_BASE_FIELD_KEYS.join(", ");
  return [
    getAiConstitutionPreamble(),
    "",
    "You are the Site Maker scaffolding assistant for a mass-tort plaintiff CRM.",
    "Given a tort/injury display name and its category, you PROPOSE the tort-specific",
    "layer of a public intake site. You do NOT build the whole form — the system",
    "already auto-attaches and LOCKS a canonical compliance spine (contact fields,",
    "base eligibility, anti-fraud probes, TCPA consent, base rules). Your job is only",
    "the tort-specific additions on top of that spine.",
    "",
    "HARD RULES:",
    `- These field keys are LOCKED and already present — NEVER emit a custom_field or`,
    `  eligibility rule that uses any of them: ${lockedKeys}.`,
    "- custom_fields: tort-specific eligibility questions (section:\"eligibility\") and",
    "  diagnosis/exposure/story questions (section:\"story\"). Keys must be snake_case.",
    "- eligibility_rules: knockout rules referencing ONLY your own custom_field keys.",
    "  op is one of eq|ne|in|not_in|lt|gt; value matches the option being knocked out.",
    "- This is NOT a law firm. Never imply guaranteed outcomes, settlement amounts, or",
    "  that submitting forms an attorney-client relationship. Keep SEO copy compliant.",
    "- decision: QUALIFIED if this is a well-known, clearly actionable mass tort;",
    "  REVIEW if it is plausible but ambiguous/novel and a human should check it;",
    "  REJECTED if it is not a viable mass tort, is frivolous, or you cannot scaffold it.",
    "- confidence is 0..1. reasons explains the decision in short bullets.",
    "- eligibility_checklist: 3-8 plain-English bullets a claimant can self-check.",
    "- severity_tiers: optional injury-severity bands relevant to this tort.",
    "- statute_hint: a non-binding, general note about timing/statute-of-limitations",
    "  considerations. Always frame as general info, never legal advice.",
    "",
    "Respond with a SINGLE JSON object and NOTHING else, matching exactly:",
    "{",
    '  "decision": "QUALIFIED|REVIEW|REJECTED",',
    '  "confidence": 0.0,',
    '  "reasons": ["..."],',
    '  "custom_fields": [{"key","label","type","section","required","options?","helper_text?","placeholder?","max_length?"}],',
    '  "eligibility_rules": [{"id","field","op","value","message"}],',
    '  "eligibility_checklist": ["..."],',
    '  "severity_tiers": [{"tier","description"}],',
    '  "statute_hint": "...",',
    '  "seo": {"meta_title","meta_description","keywords":["..."],"hero_headline","hero_subhead"}',
    "}",
    "Field type is one of: text,email,tel,date,number,select,radio,textarea,checkbox,state.",
    "Field section is one of: eligibility,contact,story.",
  ].join("\n");
}

export interface ScaffoldInput {
  displayName: string;
  category: string;
}

export async function scaffoldTortSite(
  input: ScaffoldInput,
  opts?: { maxAttempts?: number; maxTotalMs?: number },
): Promise<ScaffoldResult> {
  const displayName = input.displayName.trim();
  const category = input.category.trim();
  const systemPrompt = buildSystemPrompt();

  const baseUserPrompt = [
    `Tort / injury display name: ${displayName}`,
    `Category: ${category}`,
    CANONICAL_CATEGORIES.includes(category as (typeof CANONICAL_CATEGORIES)[number])
      ? ""
      : `(Note: category is non-canonical; canonical set is ${CANONICAL_CATEGORIES.join(", ")}.)`,
    "Propose the tort-specific layer now.",
  ]
    .filter(Boolean)
    .join("\n");

  const lockedKeys = new Set<string>(CANONICAL_BASE_FIELD_KEYS);

  const runOneAttempt = async (ctx: {
    perspectiveIndex: number;
    totalAttempts: number;
    previousError: { code: string; message: string } | null;
  }): Promise<AttemptOutcome<ScaffoldProposal>> => {
    const cue = perspectiveCue(ctx.perspectiveIndex);
    const previousErrorBlock = ctx.previousError
      ? `\nPREVIOUS ATTEMPT FAILED:\n  code: ${ctx.previousError.code}\n  message: ${ctx.previousError.message.slice(0, 600)}\nAddress this in your next response.`
      : "";
    const attemptUserPrompt = [baseUserPrompt, cue ? `\n${cue}` : "", previousErrorBlock]
      .filter(Boolean)
      .join("\n");

    let raw: string;
    try {
      raw = await callLLM({
        module: "lead-intelligence",
        systemPrompt,
        prompt: attemptUserPrompt,
        maxTokens: 2500,
      });
    } catch (err: unknown) {
      return {
        ok: false,
        errorCode: "llm_unavailable",
        errorMessage: err instanceof Error ? err.message : "AI provider unreachable",
      };
    }

    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/m, "")
      .trim();
    let payload: unknown;
    try {
      payload = JSON.parse(cleaned);
    } catch {
      return {
        ok: false,
        errorCode: "scaffold_invalid_json",
        errorMessage: "Scaffold assistant did not return valid JSON.",
        errorDetails: { raw: cleaned.slice(0, 800) },
      };
    }

    const parsed = scaffoldRawSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        errorCode: "scaffold_bad_shape",
        errorMessage: "Scaffold proposal does not match the expected shape.",
        errorDetails: parsed.error.flatten(),
      };
    }

    const data = parsed.data;

    // Strip any field/rule that collides with the locked canonical spine.
    const droppedKeys: string[] = [];
    const customFields: WebFormField[] = data.custom_fields.filter((f) => {
      if (lockedKeys.has(f.key)) {
        droppedKeys.push(f.key);
        return false;
      }
      return true;
    });
    const allowedFieldKeys = new Set(customFields.map((f) => f.key));
    const eligibilityRules: EligibilityRule[] = data.eligibility_rules.filter((r) => {
      // Only keep rules that reference a surviving custom field key.
      return allowedFieldKeys.has(r.field);
    });

    if (droppedKeys.length > 0) {
      logger.warn(
        { displayName, droppedKeys },
        "site-scaffold: dropped AI custom fields colliding with locked canonical keys",
      );
    }

    return {
      ok: true,
      value: {
        decision: data.decision,
        confidence: data.confidence,
        reasons: data.reasons,
        customFields,
        eligibilityRules,
        eligibilityChecklist: data.eligibility_checklist,
        severityTiers: data.severity_tiers,
        statuteHint: data.statute_hint,
        seo: data.seo,
      },
    };
  };

  const result = await recursiveRetry({
    attempt: runOneAttempt,
    maxAttempts: opts?.maxAttempts ?? 4,
    maxTotalMs: opts?.maxTotalMs ?? 30_000,
  });

  if (!result.ok) {
    logger.warn(
      {
        displayName,
        code: result.lastError.code,
        attempts: result.attempts.length,
        stoppedReason: result.stoppedReason,
      },
      "scaffoldTortSite: all retries failed",
    );
    return {
      ok: false,
      code: result.lastError.code,
      message: result.lastError.message,
      details: result.lastError.details,
      attempts: result.attempts,
      stoppedReason: result.stoppedReason,
    };
  }

  return {
    ok: true,
    proposal: result.value,
    attempts: result.attempts,
    stoppedReason: result.stoppedReason,
  };
}

// Re-exported so callers don't need a second import for the customField type
// when persisting accepted proposals as legacy operator-intake custom_fields.
export type { CustomField };
export { customFieldSchema };
