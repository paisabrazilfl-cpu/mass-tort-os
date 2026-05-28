/**
 * Bitdeer AI Cloud adapter — the single LLM / vision / embeddings engine
 * for Mass Tort OS.
 *
 * Bitdeer exposes an OpenAI-compatible surface at api-inference.bitdeer.ai/v1:
 *   • POST /chat/completions    chat + vision (content-array image_url)
 *   • POST /embeddings          BAAI/bge-m3
 *   • POST /rerank              BAAI/bge-reranker-v2-m3   (see lib/reranker.ts)
 *   • POST /images/generations  google/imagen-4.0-ultra   (generateImage below)
 *
 * AUTH — vault-first, env-fallback:
 *   1. integrations row provider="bitdeer"  (creds.api_key)
 *   2. BITDEER_API_KEY env var
 *
 * MODELS are role-addressed (BITDEER_MODELS) so callers ask for a capability
 * — "planner", "vision", "code" — and never hardcode a model string. Each
 * role is overridable at deploy time via BITDEER_MODEL_<ROLE>.
 *
 * REASONING MODELS — the planner (Nemotron-3-Super) and vision (Nemotron-Omni)
 * models emit a hidden chain-of-thought into `reasoning_content`, and that
 * thinking is billed against `max_tokens`. A caller asking for 300 output
 * tokens would otherwise get an empty answer because reasoning consumed the
 * budget. The adapter adds REASONING_HEADROOM to `max_tokens` for those models
 * so the caller's requested output budget survives intact.
 */
import type {
  LlmAdapter,
  LlmCompletionOutcome,
  LlmCompletionRequest,
  LlmChatRequest,
  LlmEmbedOutcome,
  LlmEmbedRequest,
  LlmError,
} from "./types";
import type { DecryptedCredentials } from "../../routes/integrations";
import { logger } from "../logger";

export const BITDEER_BASE_URL = (
  process.env["BITDEER_BASE_URL"] || "https://api-inference.bitdeer.ai/v1"
).replace(/\/+$/, "");

/** Capability roles → the Bitdeer model that serves them. */
export type BitdeerRole =
  | "chat"           // Main Chat  — Qwen3-235B: reasoning, planning, general
  | "cheap_backup"   // Cheap Backup — gpt-oss-20b: low-cost fallback before Anthropic
  | "code"           // Code        — Devstral-2: code generation, code review
  | "hard_code"      // Hard Code   — Qwen3-Coder-Plus: deep code / reasoning + code
  | "shell"          // Shell       — Devstral-2: bash / shell script generation
  | "planner"        // Planner     — Nemotron-3-Super: multi-step task decomposition
  | "router"         // Router      — Gemma-4-E4B: cheap routing / intent classification
  | "vision"         // Vision      — Qwen3-235B: multimodal, document image analysis
  | "image"          // Image gen   — Imagen-4 ultra: text-to-image
  | "embed"          // Embeddings  — BAAI/bge-m3: semantic vectors
  | "rerank";        // Reranker    — BAAI/bge-reranker-v2-m3: precision re-scoring

const DEFAULT_MODELS: Record<BitdeerRole, string> = {
  chat:         "Qwen/Qwen3-235B-A22B",
  cheap_backup: "openai/gpt-oss-20b",
  code:         "mistralai/Devstral-2-123B-Instruct-2512",
  hard_code:    "Qwen/Qwen3-Coder-Plus",
  shell:        "mistralai/Devstral-2-123B-Instruct-2512",
  planner:      "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B",
  router:       "google/gemma-4-E4B-it",
  // Vision: Qwen3-235B is multimodal and accepts image_url content-array
  // messages, making it the right pick for document-image analysis tasks.
  vision:       "Qwen/Qwen3-235B-A22B",
  image:        "google/imagen-4.0-ultra",
  embed:        "BAAI/bge-m3",
  rerank:       "BAAI/bge-reranker-v2-m3",
};

/**
 * Role → model, resolved once at module load. A `BITDEER_MODEL_<ROLE>` env
 * var (e.g. BITDEER_MODEL_PLANNER) overrides the default for that role so a
 * model can be swapped without a code change.
 */
export const BITDEER_MODELS: Readonly<Record<BitdeerRole, string>> = Object.freeze(
  (Object.keys(DEFAULT_MODELS) as BitdeerRole[]).reduce(
    (acc, role) => {
      acc[role] = process.env[`BITDEER_MODEL_${role.toUpperCase()}`]?.trim() || DEFAULT_MODELS[role];
      return acc;
    },
    {} as Record<BitdeerRole, string>,
  ),
);

/**
 * Per-module model routing for the Bitdeer provider.
 *
 * When `callLLM` resolves to the "bitdeer" provider and no explicit `model`
 * field is set on the request, it consults this map to select the role-
 * appropriate model for the calling module. This keeps module owners from
 * hard-coding model strings while still getting specialized inference.
 *
 *   "run-script"  → hard_code (Qwen3-Coder-Plus)  — deep code + reasoning
 *   "ai-agent"    → chat      (Qwen3-235B)         — multi-turn reasoning
 *   "ai-ocr"      → vision    (Qwen3-235B)         — multimodal extraction
 *   "drafting-ai" → planner   (Nemotron-3-Super)   — long-form legal drafting
 *
 * All other modules fall through to BITDEER_MODELS.chat.
 */
export const BITDEER_MODULE_MODELS: Record<string, string> = {
  "run-script":       BITDEER_MODELS.hard_code,
  "ai-agent":         BITDEER_MODELS.chat,
  "ai-ocr":           BITDEER_MODELS.vision,
  "drafting-ai":      BITDEER_MODELS.planner,
  "ai-extract":       BITDEER_MODELS.chat,
  "ai-fields":        BITDEER_MODELS.chat,
  "threat-analyzer":  BITDEER_MODELS.router,
  "lead-intelligence": BITDEER_MODELS.chat,
};

/**
 * Models that spend part of their `max_tokens` budget on a hidden
 * chain-of-thought before emitting visible output. REASONING_HEADROOM is added
 * to the caller-requested max_tokens so the output budget survives the thinking
 * phase intact.
 *
 * Qwen3-235B (chat/vision) and Qwen3-Coder-Plus (hard_code) both operate in
 * extended thinking mode by default. gpt-oss-20b and Devstral are non-thinking.
 */
const REASONING_MODELS = new Set<string>([
  BITDEER_MODELS.planner,
  BITDEER_MODELS.chat,
  BITDEER_MODELS.hard_code,
  // vision shares the same model id as chat; add explicitly for clarity
  BITDEER_MODELS.vision,
]);

/** Extra token budget granted to reasoning models so requested output survives. */
const REASONING_HEADROOM = (() => {
  const n = Number(process.env["BITDEER_REASONING_HEADROOM"]);
  return Number.isFinite(n) && n >= 0 ? n : 1536;
})();

const DEFAULT_TIMEOUT_MS = 90_000;
const NO_KEY_MESSAGE =
  "Bitdeer api_key missing — paste your inference key in Integrations Hub → AI / LLM → Bitdeer AI Cloud, or set BITDEER_API_KEY.";

/** Vault key first, then the BITDEER_API_KEY env var. */
function resolveKey(creds: DecryptedCredentials | null): string | null {
  const vaultKey = typeof creds?.api_key === "string" ? creds.api_key.trim() : "";
  if (vaultKey) return vaultKey;
  const envKey = process.env["BITDEER_API_KEY"]?.trim();
  return envKey || null;
}

/** Reasoning models need headroom so the caller's output budget survives. */
function effectiveMaxTokens(model: string, requested: number): number {
  return REASONING_MODELS.has(model) ? requested + REASONING_HEADROOM : requested;
}

/** POST JSON to a Bitdeer endpoint with one retry on 429/5xx and a hard timeout. */
async function bitdeerPost(
  path: string,
  key: string,
  body: unknown,
): Promise<{ ok: true; json: any } | LlmError> {
  const url = `${BITDEER_BASE_URL}/${path.replace(/^\/+/, "")}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt === 0) continue;
      const name = (err as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, retryable: true, code: "timeout", message: `bitdeer ${path}: request timed out` };
      }
      logger.error({ err, path }, "bitdeer network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt === 0) continue;
    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      logger.warn({ status: resp.status, path }, "bitdeer upstream non-2xx");
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `bitdeer ${path}: HTTP ${resp.status} ${text.slice(0, 200)}`,
      };
    }
    try {
      return { ok: true, json: text ? JSON.parse(text) : {} };
    } catch {
      return { ok: false, retryable: false, code: "bad_response", message: `bitdeer ${path}: non-JSON response` };
    }
  }
  return { ok: false, retryable: true, code: "exhausted", message: `bitdeer ${path}: retries exhausted` };
}

/** Parse an OpenAI-shaped chat-completion body into a normalized outcome. */
function parseChatResponse(json: any, model: string): LlmCompletionOutcome {
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  const text = typeof msg.content === "string" ? msg.content : "";

  if (!text) {
    // Reasoning model burned the whole budget on chain-of-thought without
    // emitting a final answer — honest failure, not a silent empty string.
    if (choice?.finish_reason === "length") {
      return {
        ok: false,
        retryable: false,
        code: "output_truncated",
        message: `bitdeer ${model}: response truncated before any content (finish_reason=length) — increase maxTokens.`,
      };
    }
    if (typeof msg.content !== "string") {
      return { ok: false, retryable: false, code: "bad_response", message: `bitdeer ${model}: missing message.content` };
    }
  }

  return {
    ok: true,
    text,
    model,
    usage: json?.usage
      ? { input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens }
      : undefined,
  };
}

export const bitdeerAdapter: LlmAdapter = {
  provider: "bitdeer",
  defaultModel: BITDEER_MODELS.chat,

  /**
   * Single-prompt completion. Vision requests (imageBase64 set) route to the
   * vision model unless the caller pinned an explicit model.
   */
  async complete(creds, req: LlmCompletionRequest): Promise<LlmCompletionOutcome> {
    const key = resolveKey(creds);
    if (!key) return { ok: false, retryable: false, code: "no_api_key", message: NO_KEY_MESSAGE };
    const model = req.model || (req.imageBase64 ? BITDEER_MODELS.vision : BITDEER_MODELS.chat);

    const messages: Array<{ role: string; content: unknown }> = [];
    if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
    if (req.imageBase64 && req.imageMimeType) {
      messages.push({
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${req.imageMimeType};base64,${req.imageBase64}` } },
          { type: "text", text: req.prompt },
        ],
      });
    } else {
      messages.push({ role: "user", content: req.prompt });
    }

    const payload: Record<string, unknown> = {
      model,
      messages,
      max_tokens: effectiveMaxTokens(model, req.maxTokens),
    };
    if (req.temperature !== undefined) payload.temperature = req.temperature;

    const res = await bitdeerPost("chat/completions", key, payload);
    if (!res.ok) return res;
    return parseChatResponse(res.json, model);
  },

  /** Native multi-turn chat — forwards turns straight to /chat/completions. */
  async chat(creds, req: LlmChatRequest): Promise<LlmCompletionOutcome> {
    const key = resolveKey(creds);
    if (!key) return { ok: false, retryable: false, code: "no_api_key", message: NO_KEY_MESSAGE };
    const model = req.model || BITDEER_MODELS.chat;
    const payload: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: effectiveMaxTokens(model, req.maxTokens),
    };
    if (req.temperature !== undefined) payload.temperature = req.temperature;

    const res = await bitdeerPost("chat/completions", key, payload);
    if (!res.ok) return res;
    return parseChatResponse(res.json, model);
  },

  /** Text embeddings via BAAI/bge-m3 (OpenAI-compatible /embeddings). */
  async embed(creds, req: LlmEmbedRequest): Promise<LlmEmbedOutcome> {
    const key = resolveKey(creds);
    if (!key) return { ok: false, retryable: false, code: "no_api_key", message: NO_KEY_MESSAGE };
    const model = req.model || BITDEER_MODELS.embed;
    const res = await bitdeerPost("embeddings", key, { model, input: req.inputs });
    if (!res.ok) return res;
    const rows = (res.json?.data ?? []) as Array<{ embedding?: number[] }>;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, retryable: false, code: "bad_response", message: "bitdeer embed: empty data array" };
    }
    return {
      ok: true,
      model,
      vectors: rows.map((r) => r.embedding ?? []),
      usage: { input_tokens: res.json?.usage?.prompt_tokens },
    };
  },
};

export interface GenerateImageOptions {
  /** Vault credentials; falls back to BITDEER_API_KEY env. */
  creds?: DecryptedCredentials | null;
  /** Output size, e.g. "1024x1024". */
  size?: string;
  /** Number of images. Default 1. */
  n?: number;
  /** Override the image model. Default google/imagen-4.0-ultra. */
  model?: string;
}

export interface GenerateImageResult {
  ok: true;
  model: string;
  /** Each item is either a hosted URL or a `data:image/...;base64,` URI. */
  images: string[];
}

/**
 * Text-to-image generation via Bitdeer (/images/generations). Exposed as a
 * standalone helper — no route or automation node consumes it today, but the
 * capability is wired and reachable for future surfaces.
 */
export async function generateImage(
  prompt: string,
  opts: GenerateImageOptions = {},
): Promise<GenerateImageResult | LlmError> {
  const key = resolveKey(opts.creds ?? null);
  if (!key) return { ok: false, retryable: false, code: "no_api_key", message: NO_KEY_MESSAGE };
  const model = opts.model || BITDEER_MODELS.image;
  const res = await bitdeerPost("images/generations", key, {
    model,
    prompt,
    size: opts.size || "1024x1024",
    n: opts.n && opts.n > 0 ? opts.n : 1,
  });
  if (!res.ok) return res;
  const rows = (res.json?.data ?? []) as Array<{ url?: string; b64_json?: string }>;
  const images = rows
    .map((r) => (r.url ? r.url : r.b64_json ? `data:image/png;base64,${r.b64_json}` : ""))
    .filter(Boolean);
  return { ok: true, model, images };
}
