/**
 * Live verifier for any Email provider.
 *   Usage:
 *     TEST_EMAIL=1 EMAIL_PROVIDER=postmark EMAIL_TO=you@example.com \
 *     EMAIL_FROM=alerts@yourdomain.com pnpm tsx src/scripts/verify-email.ts
 */
import { runVerify } from "./_verify-helper";
import { getEmailAdapter } from "../lib/email";

const provider = (process.env.EMAIL_PROVIDER || "").toLowerCase();
const to = process.env.EMAIL_TO || "";
const from = process.env.EMAIL_FROM || "";
if (!provider || !to || !from) {
  console.error("Set EMAIL_PROVIDER, EMAIL_TO, EMAIL_FROM.");
  process.exit(1);
}

await runVerify(provider, "TEST_EMAIL", async ({ creds }) => {
  const adapter = getEmailAdapter(provider);
  if (!adapter) return { ok: false, detail: `unknown Email provider ${provider}` };
  const out = await adapter.send(creds, {
    to,
    fromEmail: from,
    fromName: "MTOS Verify",
    subject: "MTOS verify-email ping",
    html: "<p>This is a verification ping from <code>verify-email.ts</code>.</p>",
    text: "MTOS verify-email ping",
  });
  if (!out.ok) return { ok: false, detail: `${out.code} ${out.message}` };
  return { ok: true, detail: `sent id=${out.externalMessageId ?? "—"}` };
});
