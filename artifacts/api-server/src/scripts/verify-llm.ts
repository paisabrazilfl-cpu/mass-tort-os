/**
 * Live verifier for any LLM provider.
 *   Usage: TEST_LLM=1 LLM_PROVIDER=groq pnpm tsx src/scripts/verify-llm.ts
 * Issues a tiny "ping" completion through the chosen adapter so you
 * confirm the vault credentials, network, and model name end-to-end.
 */
import { runVerify } from "./_verify-helper";
import { getLlmAdapter } from "../lib/ai";

const provider = (process.env.LLM_PROVIDER || "").toLowerCase();
if (!provider) {
  console.error("Set LLM_PROVIDER=<name> to choose which adapter to test.");
  process.exit(1);
}

await runVerify(provider, "TEST_LLM", async ({ creds }) => {
  const adapter = getLlmAdapter(provider);
  if (!adapter) return { ok: false, detail: `unknown LLM provider ${provider}` };
  const out = await adapter.complete(creds, {
    prompt: "Reply with the single word: pong.",
    maxTokens: 16,
  });
  if (!out.ok) return { ok: false, detail: `${out.code} ${out.message}` };
  return { ok: true, detail: `model=${out.model} text=${JSON.stringify(out.text.slice(0, 80))}` };
});
