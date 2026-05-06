/**
 * Live verifier for any Voice AI provider.
 *   Usage: TEST_VOICE=1 VOICE_PROVIDER=retell_ai pnpm tsx src/scripts/verify-voice.ts
 * Lists the configured assistants — confirms api_key + network.
 */
import { runVerify } from "./_verify-helper";
import { getVoiceAdapter } from "../lib/voice";

const provider = (process.env.VOICE_PROVIDER || "").toLowerCase();
if (!provider) {
  console.error("Set VOICE_PROVIDER=<name>.");
  process.exit(1);
}

await runVerify(provider, "TEST_VOICE", async ({ creds }) => {
  const adapter = getVoiceAdapter(provider);
  if (!adapter) return { ok: false, detail: `unknown Voice provider ${provider}` };
  const out = await adapter.listAssistants(creds);
  if (!out.ok) return { ok: false, detail: `${out.code} ${out.message}` };
  return { ok: true, detail: `assistants=${out.assistants.length}` };
});
