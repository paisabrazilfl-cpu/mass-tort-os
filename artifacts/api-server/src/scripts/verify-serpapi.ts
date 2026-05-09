/**
 * Live verifier for SerpAPI.
 *   Usage: TEST_SEARCH=1 pnpm tsx src/scripts/verify-serpapi.ts
 * Issues a tiny "ping" search through the adapter so you confirm vault
 * credentials, network, and API plan end-to-end.
 */
import { runVerify } from "./_verify-helper";
import { serpapiAdapter } from "../lib/search/serpapi";

await runVerify("serpapi", "TEST_SEARCH", async ({ creds }) => {
  const out = await serpapiAdapter.search(creds, {
    query: "openai",
    engine: "google",
    num: 3,
  });
  if (!out.ok) return { ok: false, detail: `${out.code} ${out.message}` };
  const titles = out.results.slice(0, 3).map((r) => r.title).join(" | ");
  return { ok: true, detail: `engine=${out.engine} results=${out.results.length} top=${JSON.stringify(titles.slice(0, 120))}` };
});
