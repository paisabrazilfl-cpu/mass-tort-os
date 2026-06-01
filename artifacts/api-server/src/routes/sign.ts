// Public claimant signing redirect.
//
//   GET /sign/:token  — verifies a stateless signing token (lead id only, no
//                       PII), finds the lead's next pending e-sign envelope,
//                       mints a FRESH provider signer URL, and either redirects
//                       (DocuSign recipient view is directly openable) or serves
//                       a minimal same-origin wrapper that loads the Dropbox Sign
//                       embedded SDK. Degrades to a friendly HTML page on every
//                       miss — never throws, never leaks PII.
//
// This router is PUBLIC (markPublic) — no JWT. It must be mounted BEFORE the SPA
// fallback so /sign never falls through to the React app. The /sign prefix is
// registered to the api-server artifact (artifact.toml services.paths) so the
// shared proxy routes it here, not to the SPA.
import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, leadsTable, documentEnvelopesTable } from "@workspace/db";
import crypto from "node:crypto";
import { markPublic } from "../lib/route-protection";
import { logger } from "../lib/logger";
import { auditLog } from "../lib/audit";
import { decryptLeadFields } from "../lib/encryption";
import { getEsignAdapter } from "../lib/esign";
import { verifySigningToken, getPublicBaseUrl } from "../lib/esign/signing-token";
import { getIntegrationCredentialsById } from "./integrations";

const router = Router();

// Envelope statuses that are terminal (no longer signable). Anything else with
// an external_envelope_id is treated as still-pending and signable.
const TERMINAL_STATUSES = new Set(["signed", "completed", "declined", "voided", "expired", "error"]);

function page(title: string, message: string, status = 200): { status: number; html: string } {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style nonce="__NONCE__">
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0f172a; color: #e2e8f0; margin: 0; display: flex; min-height: 100vh;
    align-items: center; justify-content: center; padding: 24px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px;
    padding: 32px; max-width: 440px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.5; color: #cbd5e1; margin: 0; }
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
  return { status, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

// Same-origin wrapper that opens a Dropbox Sign embedded sign URL via their SDK.
// The embedded sign_url is NOT directly openable — it must be handed to the
// HelloSign embedded client. We set a per-response CSP (with a nonce) so the SDK
// and our init script load despite the strict global helmet policy.
function dropboxWrapper(signUrl: string, clientId: string, returnUrl: string, nonce: string): string {
  const skipDomainVerification = process.env.NODE_ENV !== "production";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign your documents</title>
<style nonce="${nonce}">html,body{margin:0;height:100%;background:#0f172a;}</style>
</head><body>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/hellosign-embedded@2.10.0/umd/embedded.production.min.js"></script>
<script nonce="${nonce}">
  (function () {
    var signUrl = ${JSON.stringify(signUrl)};
    var clientId = ${JSON.stringify(clientId)};
    var returnUrl = ${JSON.stringify(returnUrl)};
    try {
      var client = new HelloSign({ clientId: clientId });
      client.open(signUrl, { skipDomainVerification: ${skipDomainVerification ? "true" : "false"} });
      client.on("sign", function () { window.location.href = returnUrl; });
      client.on("close", function () { /* claimant closed; stay on page */ });
    } catch (e) {
      document.body.innerHTML = '<p style="color:#e2e8f0;font-family:sans-serif;padding:24px">Unable to open the signing session. Please try the link again or contact your case manager.</p>';
    }
  })();
</script>
</body></html>`;
}

router.get("/sign/:token", async (req, res) => {
  const sendPage = (p: { status: number; html: string }) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; frame-src 'none'`,
    );
    res.status(p.status).type("html").send(p.html.replace(/__NONCE__/g, nonce));
  };

  const verified = verifySigningToken(req.params.token);
  if (!verified) {
    return sendPage(page("Link expired", "This signing link is invalid or has expired. Please contact your case manager for a new one.", 400));
  }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, verified.leadId));
  if (!lead) {
    return sendPage(page("Not found", "We couldn't find your record. Please contact your case manager.", 404));
  }

  const envelopes = await db
    .select()
    .from(documentEnvelopesTable)
    .where(eq(documentEnvelopesTable.lead_id, verified.leadId));

  const pending = envelopes
    .filter((e) => e.external_envelope_id && !TERMINAL_STATUSES.has(e.status))
    .sort((a, b) => a.id - b.id);

  if (pending.length === 0) {
    return sendPage(page("All done", "All your documents are signed. Thank you! You can close this page.", 200));
  }

  const env = pending[0];
  const adapter = getEsignAdapter(env.provider);
  if (!adapter?.createSignerUrl || !env.provider_integration_id) {
    return sendPage(page(
      "Almost there",
      "Your documents are ready, but online signing isn't available right now. Your case manager will follow up shortly.",
      200,
    ));
  }

  const creds = await getIntegrationCredentialsById(env.provider_integration_id);
  if (!creds) {
    return sendPage(page("Almost there", "Your documents are ready. Your case manager will follow up shortly.", 200));
  }

  const decrypted = decryptLeadFields(lead, String(lead.id));
  const signerEmail = typeof decrypted.email === "string" ? decrypted.email : "";
  const signerName =
    (typeof decrypted.name === "string" && decrypted.name) ||
    `${decrypted.first_name ?? ""} ${decrypted.last_name ?? ""}`.trim() ||
    "Claimant";
  const returnUrl = `${getPublicBaseUrl()}/sign/${req.params.token}`;
  const meta = (env.metadata as Record<string, unknown> | null) ?? {};

  let signerUrl: string | null = null;
  try {
    signerUrl = await adapter.createSignerUrl(creds, env.external_envelope_id!, {
      signerEmail,
      signerName,
      returnUrl,
      embeddedSignatureId: typeof meta.embedded_signature_id === "string" ? meta.embedded_signature_id : null,
      clientId: typeof (creds as Record<string, unknown>).client_id === "string"
        ? ((creds as Record<string, unknown>).client_id as string)
        : null,
    });
  } catch (err) {
    logger.error({ err, envelope_id: env.id }, "sign route: createSignerUrl threw");
  }

  if (!signerUrl) {
    return sendPage(page(
      "Try again shortly",
      "We couldn't open your signing session right now. Please try the link again in a few minutes, or contact your case manager.",
      200,
    ));
  }

  await auditLog("document_envelope", String(env.id), "signer_url_issued", {
    lead_id: verified.leadId,
    provider: env.provider,
  });

  // DocuSign recipient-view URLs are directly openable — redirect.
  if (env.provider === "docusign") {
    return res.redirect(302, signerUrl);
  }

  // Dropbox Sign embedded sign URLs must be opened via their JS SDK — serve a
  // same-origin wrapper with a per-response CSP that permits the SDK + iframe.
  if (env.provider === "dropbox_sign") {
    const clientId = typeof (creds as Record<string, unknown>).client_id === "string"
      ? ((creds as Record<string, unknown>).client_id as string)
      : "";
    const nonce = crypto.randomBytes(16).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net`,
        `style-src 'self' 'nonce-${nonce}'`,
        "img-src 'self' data: https:",
        "frame-src https://app.hellosign.com https://*.hellosign.com",
        "connect-src 'self' https://*.hellosign.com",
      ].join("; "),
    );
    return res.status(200).type("html").send(dropboxWrapper(signerUrl, clientId, returnUrl, nonce));
  }

  // Unknown provider that nonetheless produced a URL — best-effort redirect.
  return res.redirect(302, signerUrl);
});

export default markPublic(router, "sign");
