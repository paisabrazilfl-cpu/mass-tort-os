/**
 * Live verifier for any Fax provider.
 *   Usage:
 *     TEST_FAX=1 FAX_PROVIDER=phaxio FAX_TO=+15551234567 \
 *     pnpm tsx src/scripts/verify-fax.ts
 *
 * Sends a one-page text PDF.  PDF is generated inline so the script
 * has no on-disk dependencies.
 */
import { runVerify } from "./_verify-helper";
import { getFaxAdapter } from "../lib/fax";

const provider = (process.env.FAX_PROVIDER || "").toLowerCase();
const to = process.env.FAX_TO || "";
if (!provider || !to) {
  console.error("Set FAX_PROVIDER and FAX_TO=<E.164 fax>.");
  process.exit(1);
}

// Tiny valid PDF — "Hello" on one page. https://stackoverflow.com/a/17280876
const tinyPdf = Buffer.from(
  "%PDF-1.1\n%\xC3\xA4\xC3\xBC\xC3\xB6\xC3\x9F\n1 0 obj\n  << /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n  << /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n  << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n4 0 obj\n  << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n5 0 obj\n  << /Length 44 >>\nstream\nBT /F1 24 Tf 100 700 Td (MTOS verify-fax) Tj ET\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f\n0000000018 00000 n\n0000000077 00000 n\n0000000178 00000 n\n0000000457 00000 n\n0000000565 00000 n\ntrailer\n  << /Size 6 /Root 1 0 R >>\nstartxref\n625\n%%EOF",
  "binary",
);

await runVerify(provider, "TEST_FAX", async ({ creds }) => {
  const adapter = getFaxAdapter(provider);
  if (!adapter) return { ok: false, detail: `unknown Fax provider ${provider}` };
  const out = await adapter.send(creds, { toNumber: to, pdf: tinyPdf, fileName: "verify-fax.pdf" });
  if (!out.ok) return { ok: false, detail: `${out.code} ${out.message}` };
  return { ok: true, detail: `queued id=${out.externalFaxId}` };
});
