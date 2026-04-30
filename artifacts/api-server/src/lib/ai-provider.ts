import { logger } from "./logger";
import type { Message } from "@anthropic-ai/sdk/resources/index.js";

export type LLMModule =
  | "ai-extract"
  | "ai-fields"
  | "ai-ocr"
  | "drafting-ai"
  | "threat-analyzer"
  | "lead-intelligence";

const MODULE_ENV_KEY: Record<LLMModule, string> = {
  "ai-extract": "AI_PROVIDER_AI_EXTRACT",
  "ai-fields": "AI_PROVIDER_AI_FIELDS",
  "ai-ocr": "AI_PROVIDER_AI_OCR",
  "drafting-ai": "AI_PROVIDER_DRAFTING_AI",
  "threat-analyzer": "AI_PROVIDER_THREAT_ANALYZER",
  "lead-intelligence": "AI_PROVIDER_LEAD_INTELLIGENCE",
};

function resolveProvider(module: LLMModule): "openai" | "anthropic" {
  const moduleEnvKey = MODULE_ENV_KEY[module];
  const moduleOverride = process.env[moduleEnvKey]?.toLowerCase();
  if (moduleOverride === "anthropic" || moduleOverride === "openai") {
    return moduleOverride;
  }
  const globalDefault = process.env["AI_PROVIDER"]?.toLowerCase();
  if (globalDefault === "anthropic" || globalDefault === "openai") {
    return globalDefault;
  }
  return "openai";
}

type AnthropicCtor = typeof import("@anthropic-ai/sdk").default;
let anthropicClient: InstanceType<AnthropicCtor> | undefined;
async function getAnthropicClient(): Promise<InstanceType<AnthropicCtor>> {
  if (!anthropicClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropicClient = new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });
  }
  return anthropicClient;
}

type OpenAIModule = typeof import("@workspace/integrations-openai-ai-server");
let openaiClientHolder: OpenAIModule["openai"] | undefined;
async function getOpenAIClient(): Promise<OpenAIModule["openai"]> {
  if (!openaiClientHolder) {
    const mod = await import("@workspace/integrations-openai-ai-server");
    openaiClientHolder = mod.openai;
  }
  return openaiClientHolder;
}

type SupportedMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface LLMRequest {
  module: LLMModule;
  prompt: string;
  maxTokens: number;
  systemPrompt?: string;
  imageBase64?: string;
  imageMimeType?: SupportedMime;
}

export async function callLLM({ module, prompt, maxTokens, systemPrompt, imageBase64, imageMimeType }: LLMRequest): Promise<string> {
  const provider = resolveProvider(module);
  logger.debug({ module, provider, hasImage: !!imageBase64, hasSystem: !!systemPrompt }, "callLLM dispatching");

  if (provider === "anthropic") {
    const anthropic = await getAnthropicClient();
    type AnthropicContent = Parameters<typeof anthropic.messages.create>[0]["messages"][0]["content"];

    let content: AnthropicContent;
    if (imageBase64 && imageMimeType) {
      content = [
        { type: "image", source: { type: "base64", media_type: imageMimeType, data: imageBase64 } },
        { type: "text", text: prompt },
      ];
    } else {
      content = prompt;
    }

    const params: Parameters<typeof anthropic.messages.create>[0] = {
      model: "claude-haiku-4-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    };
    if (systemPrompt) params.system = systemPrompt;

    const response = (await anthropic.messages.create(params)) as Message;
    const block = response.content[0];
    return block.type === "text" ? block.text : "";
  }

  const client = await getOpenAIClient();

  type OAIMessage = Parameters<typeof client.chat.completions.create>[0]["messages"][0];
  type OAIContent = OAIMessage["content"];

  let userContent: OAIContent;
  if (imageBase64 && imageMimeType) {
    userContent = [
      { type: "image_url", image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } },
      { type: "text", text: prompt },
    ];
  } else {
    userContent = prompt;
  }

  const messages: OAIMessage[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userContent });

  const response = await client.chat.completions.create({
    model: "gpt-5-mini",
    max_tokens: maxTokens,
    messages,
  });
  return response.choices[0]?.message?.content ?? "";
}
