if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
  throw new Error(
    "AI_INTEGRATIONS_ANTHROPIC_BASE_URL must be set. Did you forget to provision the Anthropic AI integration?",
  );
}

if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_ANTHROPIC_API_KEY must be set. Did you forget to provision the Anthropic AI integration?",
  );
}

// @anthropic-ai/sdk is heavy (~346 KB + iconv-lite transitive ~530 KB).
// We lazy-`await import()` it on first use so consumers that wire AI handlers
// at boot but only call them on demand (the API server, the worker) don't pay
// the parse cost during cold start. Mirrors the inline pattern in
// artifacts/api-server/src/lib/threat-analyzer.ts. The SDK is also
// externalized in artifacts/api-server/build.mjs.
type AnthropicCtor = typeof import("@anthropic-ai/sdk").default;
export type AnthropicClient = InstanceType<AnthropicCtor>;

let cachedClient: AnthropicClient | undefined;

export async function getAnthropicClient(): Promise<AnthropicClient> {
  if (!cachedClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    cachedClient = new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });
  }
  return cachedClient;
}
