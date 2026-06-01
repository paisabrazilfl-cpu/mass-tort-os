// Sites AI Chat assistant — conversational planner for the Sites/SEO domain.
//
// Given the conversation history + a snapshot of the live tort-site registry,
// the assistant either (a) answers conversationally, or (b) proposes ONE
// privileged action (rebuild-all, SEO rebuild-all, create a site, edit a site).
//
// CRITICAL CONTRACT: this planner NEVER executes anything. It only PROPOSES.
// The operator must explicitly confirm a proposal in chat, and the executor
// (lib/sites-ai/actions.ts) re-checks RBAC per action before doing any write.
// Mirrors the assist-planner / site-scaffold pattern: callLLM (lead-intelligence
// module, Bitdeer + Anthropic fallback) wrapped in recursiveRetry with
// perspective-shifting + strict zod validation, prefaced by the AI Constitution.

import { z } from "zod/v4";

import { webFormFieldSchema, eligibilityRuleSchema } from "@workspace/db";
import { callLLM } from "../ai-provider";
import { getAiConstitutionPreamble } from "../ai-constitution";
import { CANONICAL_CATEGORIES } from "../comprehensive-tort-forms";
import {
  recursiveRetry,
  perspectiveCue,
  type AttemptOutcome,
  type AttemptLog,
  type StoppedReason,
} from "../automations/recursive-retry";
import { logger } from "../logger";
import type { SitesActionKind, SitesActionProposal } from "@workspace/db";

// ── Output schema ────────────────────────────────────────────────────────────

const actionKindSchema = z.enum([
  "rebuild_all",
  "seo_rebuild_all",
  "create_site",
  "edit_site",
]);

// Params per action kind. Site create/edit mirror CreateSiteInput /
// RepublishSiteInput in form-config-service. We keep them permissive here and
// let the executor + service do the canonical validation (category, slug
// collisions, locked-key stripping).
const createSiteParamsSchema = z.object({
  label: z.string().min(1).max(200),
  category: z.string().min(1).max(120),
  slug: z.string().max(120).optional(),
  headline: z.string().max(200).optional(),
  subhead: z.string().max(400).optional(),
  introText: z.string().max(2000).nullish(),
  customFields: z.array(webFormFieldSchema).max(20).optional(),
  eligibilityRules: z.array(eligibilityRuleSchema).max(20).optional(),
});

const editSiteParamsSchema = z.object({
  slug: z.string().min(1).max(120),
  label: z.string().max(200).optional(),
  category: z.string().max(120).optional(),
  headline: z.string().max(200).optional(),
  subhead: z.string().max(400).optional(),
  introText: z.string().max(2000).nullish(),
  customFields: z.array(webFormFieldSchema).max(20).optional(),
  eligibilityRules: z.array(eligibilityRuleSchema).max(20).optional(),
});

const assistantRawSchema = z.object({
  reply: z.string().min(1).max(6000),
  action: z
    .object({
      kind: actionKindSchema,
      summary: z.string().min(1).max(1000),
      params: z.record(z.string(), z.unknown()).default({}),
    })
    .nullable()
    .default(null),
});

export interface AssistantTurn {
  reply: string;
  proposal: SitesActionProposal | null;
}

export type AssistantResult =
  | { ok: true; turn: AssistantTurn; attempts: AttemptLog[]; stoppedReason: StoppedReason }
  | {
      ok: false;
      code: string;
      message: string;
      details?: unknown;
      attempts: AttemptLog[];
      stoppedReason: Exclude<StoppedReason, "succeeded">;
    };

// ── Registry context ──────────────────────────────────────────────────────────

export interface SiteRegistryEntry {
  slug: string;
  label: string;
  category: string;
  active: boolean;
  enabled: boolean;
}

export interface ChatHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildSystemPrompt(registry: SiteRegistryEntry[]): string {
  const registryLines =
    registry.length === 0
      ? "(no tort sites exist yet)"
      : registry
          .slice(0, 200)
          .map(
            (s) =>
              `- ${s.slug} | "${s.label}" | category=${s.category} | ${s.active ? "active" : "archived"} | form ${s.enabled ? "open" : "closed"}`,
          )
          .join("\n");

  return [
    getAiConstitutionPreamble(),
    "",
    "You are the Sites AI Assistant for a mass-tort plaintiff CRM. You manage the",
    "network of public tort intake sites and their SEO pages. You can answer",
    "questions about the existing sites AND propose privileged changes.",
    "",
    "You can PROPOSE exactly one of these actions per turn (or none):",
    "- rebuild_all: re-verify + backfill every tort site's web form (serviceable",
    "  spine check). params: {}.",
    "- seo_rebuild_all: recompute the SEO page-network manifest from the live",
    "  registry and report coverage + any duplicate URLs. params: {}.",
    "- create_site: create a brand-new public tort site. params:",
    '  {label, category, slug?, headline?, subhead?, introText?, customFields?, eligibilityRules?}.',
    "- edit_site: re-publish/update an existing site (by slug). params:",
    '  {slug, label?, category?, headline?, subhead?, introText?, customFields?, eligibilityRules?}.',
    "",
    "HARD RULES:",
    "- You NEVER execute anything. You only PROPOSE. The operator must confirm in",
    "  chat, and the system re-checks their permissions before any change runs.",
    "- Only propose an action when the user clearly asks for a change. For",
    "  questions, discussion, or ambiguity, set action to null and ask a clarifying",
    "  question in reply.",
    `- category MUST be one of the canonical categories: ${CANONICAL_CATEGORIES.join(", ")}.`,
    "- For create_site/edit_site, the system auto-attaches and LOCKS a canonical",
    "  compliance spine (contact fields, base eligibility, anti-fraud probes, TCPA",
    "  consent). customFields/eligibilityRules are ONLY the tort-specific layer on",
    "  top; never include base/locked keys. customFields keys are snake_case.",
    "- This is NOT a law firm. Never imply guaranteed outcomes, settlement amounts,",
    "  or that submitting a form creates an attorney-client relationship.",
    "- reply is plain conversational text for the operator. summary is a one-line",
    "  human description of the proposed action shown on the confirmation card.",
    "",
    "SINGLE-TORT SITE STANDARDS (govern every create_site / edit_site you propose):",
    "- One tort per site. Each site covers EXACTLY ONE tort (its canonical",
    "  category). Never mix multiple torts in one site's label, copy, fields, or",
    "  branding. If the operator describes more than one tort for a single site,",
    "  stop and ask them to split it.",
    "- Multi-site requests = distinct single-tort sites. If asked for N sites,",
    "  each must be its own tort with its own label, headline, subhead, introText,",
    "  and tort-specific customFields/eligibilityRules. NEVER clone one site's copy",
    "  with only the tort name swapped. Because you may only propose ONE action per",
    "  turn, build a batch by proposing the first site, then the next after each is",
    "  confirmed — keeping every site's copy genuinely unique.",
    "- Tone & copy: clean, premium, trustworthy legal-intake voice. Headlines and",
    "  intro copy should be specific to the tort's exposure and qualifying injury.",
    "  Prohibited: guaranteed-settlement or money language, fake attorney names or",
    "  credentials, and any claim the operator cannot honestly support.",
    "- Design intent (for any copy/branding you suggest): premium clean legal look —",
    "  navy/charcoal primary, gold or teal secondary, white/light-gray background,",
    "  deep-blue or gold CTAs. No money/settlement-check imagery, no misleading",
    "  courtroom imagery, no loud/spammy styling.",
    "- SEO honesty: a confirmed seo_rebuild_all regenerates the page network this",
    "  system actually owns — shared evergreen pages plus, per live tort, a landing",
    "  page, a category hub, and supporting symptoms/diagnosis/FAQ pages. It does",
    "  NOT auto-generate per-state, per-city, blog, or resource pages, nor per-tort",
    "  image libraries, favicons, or social images. If the operator asks for those,",
    "  say plainly they are outside what rebuild produces today and offer what IS",
    "  possible — never imply pages or assets were built when they were not.",
    "",
    "EXISTING TORT SITES (slug | label | category | status | form state):",
    registryLines,
    "",
    "Respond with a SINGLE JSON object and NOTHING else, matching exactly:",
    "{",
    '  "reply": "conversational text for the operator",',
    '  "action": null OR {"kind":"rebuild_all|seo_rebuild_all|create_site|edit_site","summary":"one line","params":{...}}',
    "}",
  ].join("\n");
}

function buildHistoryBlock(history: ChatHistoryEntry[], userMessage: string): string {
  const lines = history
    .slice(-20)
    .map((h) => `${h.role === "user" ? "Operator" : "Assistant"}: ${h.content}`);
  lines.push(`Operator: ${userMessage}`);
  return lines.join("\n");
}

// ── Planner ────────────────────────────────────────────────────────────────────

export interface AssistInput {
  userMessage: string;
  history: ChatHistoryEntry[];
  registry: SiteRegistryEntry[];
  // Bounded text extracted from the operator's uploaded attachments (may be
  // empty). Injected into the user prompt so replies/proposals can use it.
  attachmentContext?: string;
}

export async function runSitesAssistant(
  input: AssistInput,
  opts?: { maxAttempts?: number; maxTotalMs?: number },
): Promise<AssistantResult> {
  const systemPrompt = buildSystemPrompt(input.registry);
  const attachmentBlock = input.attachmentContext?.trim()
    ? ["", input.attachmentContext.trim()]
    : [];
  const baseUserPrompt = [
    "Conversation so far:",
    buildHistoryBlock(input.history, input.userMessage),
    ...attachmentBlock,
    "",
    "Respond now as the Sites AI Assistant.",
  ].join("\n");

  const runOneAttempt = async (ctx: {
    perspectiveIndex: number;
    previousError: { code: string; message: string } | null;
  }): Promise<AttemptOutcome<AssistantTurn>> => {
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
        errorCode: "assist_invalid_json",
        errorMessage: "Sites assistant did not return valid JSON.",
        errorDetails: { raw: cleaned.slice(0, 800) },
      };
    }

    const parsed = assistantRawSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        errorCode: "assist_bad_shape",
        errorMessage: "Sites assistant response does not match the expected shape.",
        errorDetails: parsed.error.flatten(),
      };
    }

    const data = parsed.data;
    let proposal: SitesActionProposal | null = null;

    if (data.action) {
      const kind = data.action.kind as SitesActionKind;
      // Validate params per kind so a malformed proposal is retried rather than
      // surfaced as a broken confirmation card.
      if (kind === "create_site") {
        const p = createSiteParamsSchema.safeParse(data.action.params);
        if (!p.success) {
          return {
            ok: false,
            errorCode: "assist_bad_params",
            errorMessage: "create_site params are invalid.",
            errorDetails: p.error.flatten(),
          };
        }
        proposal = { kind, summary: data.action.summary, params: p.data };
      } else if (kind === "edit_site") {
        const p = editSiteParamsSchema.safeParse(data.action.params);
        if (!p.success) {
          return {
            ok: false,
            errorCode: "assist_bad_params",
            errorMessage: "edit_site params are invalid.",
            errorDetails: p.error.flatten(),
          };
        }
        proposal = { kind, summary: data.action.summary, params: p.data };
      } else {
        // rebuild_all / seo_rebuild_all take no params.
        proposal = { kind, summary: data.action.summary, params: {} };
      }
    }

    return { ok: true, value: { reply: data.reply, proposal } };
  };

  const result = await recursiveRetry({
    attempt: runOneAttempt,
    maxAttempts: opts?.maxAttempts ?? 4,
    maxTotalMs: opts?.maxTotalMs ?? 30_000,
  });

  if (!result.ok) {
    logger.warn(
      {
        code: result.lastError.code,
        attempts: result.attempts.length,
        stoppedReason: result.stoppedReason,
      },
      "runSitesAssistant: all retries failed",
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
    turn: result.value,
    attempts: result.attempts,
    stoppedReason: result.stoppedReason,
  };
}
