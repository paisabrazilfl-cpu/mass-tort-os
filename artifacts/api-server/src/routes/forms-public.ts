import { Router, type IRouter, type Request } from "express";
import rateLimit from "express-rate-limit";
import { getFormConfig } from "../lib/form-config-service";
import { generateEmbedScript, runSubmissionPipeline } from "./forms";
import { validateEmail } from "../lib/email-validator";
import { validateAddress } from "../lib/address-validator";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { badRequest, notFound, serverError } from "../lib/http-errors";
import { db, vendorsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

// Public, unauthenticated endpoints. Tighter per-IP rate limit than the
// global 500/15min to make tort-id enumeration / config-scraping expensive.
const publicFormsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
  keyGenerator: (req) =>
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown",
});

router.use(publicFormsRateLimit);

// Strict host pattern: alphanumerics, dot, hyphen, optional :port.
// Blocks Host-header injection vectors (CR/LF, quotes, angle brackets, spaces).
const SAFE_HOST = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

/**
 * Resolve the public base URL for embed/preview links.
 *
 * Priority:
 *   1) PUBLIC_API_BASE_URL env var (set this in production / when running
 *      behind the future host site so links never depend on Host header).
 *   2) X-Forwarded-Proto + Host header, validated against SAFE_HOST.
 *
 * If the Host header fails validation we refuse to render rather than
 * emit attacker-controlled URLs into HTML or JS.
 */
function resolveBaseUrl(req: Request): string | null {
  const fromEnv = process.env.PUBLIC_API_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");

  const host = req.get("host") ?? "";
  if (!SAFE_HOST.test(host)) return null;

  const proto = (req.get("x-forwarded-proto") ?? req.protocol ?? "https")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (proto !== "http" && proto !== "https") return null;

  return `${proto}://${host}`;
}

// CSP shared by preview HTML. TrustedForm requires:
//  - script-src + connect-src for api.trustedform.com (+ subdomains)
//  - worker-src incl. blob: for its instrumentation worker
//  - frame-src for any iframes the TF script may inject
const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' https://api.trustedform.com https://*.trustedform.com",
  "worker-src 'self' blob: https://*.trustedform.com",
  "frame-src 'self' https://*.trustedform.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://api.trustedform.com https://*.trustedform.com",
  "frame-ancestors *",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function htmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

router.get("/preview/:tortId", async (req, res) => {
  const tortId = String(req.params.tortId);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) {
      res.status(400).type("html").send("<h1>Bad request</h1>");
      return;
    }
    const config = await getFormConfig(tortId);
    if (!config) {
      res.status(404).type("html").send("<h1>Form not found</h1>");
      return;
    }
    const safeLabel = htmlEscape(config.label);
    const safeTortId = encodeURIComponent(tortId);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Preview · ${safeLabel}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;background:#f8fafc;color:#0f172a}.banner{background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px}</style>
</head>
<body>
<div class="banner"><strong>Preview Mode</strong> — submissions are disabled in this preview window.</div>
<div id="mtos-form"></div>
<script src="${htmlEscape(baseUrl)}/api/forms-public/embed/${safeTortId}"></script>
<script src="${htmlEscape(baseUrl)}/api/forms-public/preview-blocker.js"></script>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", PREVIEW_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
    res.removeHeader("X-Frame-Options");
    res.send(html);
  } catch (err) {
    logger.error({ err }, "Failed to render preview");
    res.status(500).type("html").send("<h1>Preview failed</h1>");
  }
});

router.get("/preview-blocker.js", (_req, res) => {
  const js = `document.addEventListener("submit",function(e){e.preventDefault();alert("Preview mode: form not submitted.");},true);`;
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.send(js);
});

// Public, anonymous lead submission from third-party host sites running the
// generated embed.js. Security model:
//   1. Per-IP rate limit (60/min) is applied at the router level above.
//   2. :tortId MUST resolve to an *active* form_configurations row. Inactive
//      or unknown ids 404 before any pipeline work happens — this prevents
//      enumeration probes from triggering NPI/address/email lookups.
//   3. tort_type and source are SERVER-FORCED from the resolved config; the
//      client cannot spoof which campaign a lead belongs to or which embed
//      it came from.
//   4. The shared 10-step pipeline still enforces TCPA consent (step 4) and
//      a well-formed TrustedForm certificate URL (step 5) — both required for
//      a lead to clear FINAL_ARBITER. No untrusted input bypasses validation.
//   5. Origin / Referer / source IP are recorded to audit_log so abuse can be
//      traced to a specific embed installation.
router.post("/submit/:tortId", async (req, res) => {
  const tortId = String(req.params.tortId);
  let config;
  try {
    config = await getFormConfig(tortId);
  } catch (err) {
    logger.error({ err, tortId }, "form-config lookup failed during public submit");
    serverError(res, "Form lookup failed");
    return;
  }
  if (!config || !config.active) {
    notFound(res, "Tort campaign not found or inactive");
    return;
  }

  const sourceIp =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const origin = req.get("origin") ?? null;
  const referer = req.get("referer") ?? null;

  // Server-force fields the client must not control.
  if (req.body && typeof req.body === "object") {
    req.body.tort_type = config.label;
    req.body.source = `form_embed_${tortId}`;
  }

  // Resolve optional vendor token (?v=TOKEN) and stamp vendor_id on the lead.
  // The token is the sole credential — no JWT involved. Invalid/unknown tokens
  // are silently ignored so vendors cannot probe for valid IDs.
  const vToken = req.query.v;
  if (typeof vToken === "string" && /^[0-9a-f]{32,64}$/i.test(vToken)) {
    try {
      const [vendor] = await db
        .select({ id: vendorsTable.id })
        .from(vendorsTable)
        .where(eq(vendorsTable.portal_token, vToken));
      if (vendor && req.body && typeof req.body === "object") {
        req.body.vendor_id = vendor.id;
      }
    } catch (err) {
      logger.warn({ err }, "vendor token resolution failed — lead will be unattributed");
    }
  }

  // Audit the attempt (non-blocking) so every public submission is traceable
  // even if the pipeline rejects it. A matching `form_submission_result` row
  // is written from the res 'finish' hook below — together they bookend the
  // full attempt + decision trail required for TCPA / lead-buyer disputes.
  void auditLog("form_submission_attempt", tortId, "form_embed", {
    tort_id: tortId,
    tort_label: config.label,
    source_ip: sourceIp,
    origin,
    referer,
    user_agent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err, tortId }, "audit_log write failed for public submission attempt");
  });

  // Capture the pipeline response so the result audit row can record
  // outcome + lead_id even on early-rejection paths (422 schema-rejected,
  // 400 missing TCPA, etc). Wrapping res.json is the only point that sees
  // every terminal write the pipeline emits.
  const originalJson = res.json.bind(res);
  let responseBody: unknown = null;
  res.json = (body: unknown) => {
    responseBody = body;
    return originalJson(body);
  };
  res.on("finish", () => {
    const body = (responseBody ?? {}) as Record<string, unknown>;
    const pipeline = Array.isArray(body.pipeline) ? body.pipeline : [];
    // Match BOTH "failed" and "error" so storage / unexpected pipeline errors
    // surface in the audit row instead of leaving failed_step null. Falls back
    // to a top-level body.failed_step the pipeline may have set explicitly.
    const failedStep =
      (typeof body.failed_step === "string" ? body.failed_step : null) ??
      (pipeline.find(
        (s: unknown): s is { name: string; status: string } =>
          typeof s === "object" &&
          s !== null &&
          ((s as { status?: string }).status === "failed" ||
            (s as { status?: string }).status === "error"),
      )?.name ??
        null);
    void auditLog(
      "form_submission_result",
      String(body.lead_id ?? tortId),
      "form_embed",
      {
        tort_id: tortId,
        tort_label: config.label,
        source_ip: sourceIp,
        status_code: res.statusCode,
        outcome: body.status ?? null,
        lead_id: body.lead_id ?? null,
        fraud_status: body.fraud_status ?? null,
        failed_step: failedStep,
      },
    ).catch((err) => {
      logger.warn({ err, tortId }, "audit_log write failed for public submission result");
    });
  });

  await runSubmissionPipeline(req, res);
});

// Public pre-submit validators. Used by the embed.js to give live feedback
// (typo suggestions, address completeness) before the user hits Submit. No
// PII is required — validateEmail takes only an email string and validateAddress
// takes only the address fields. Per-IP rate limit on the router caps abuse.
// Live validation for the optional hospital_fax field. Mirrors the
// server-side normalizer used at submit time so the user sees the same
// "valid / invalid" verdict before submitting. Used by the embed.js blur
// handler. Public — no PII in the response.
router.post("/validate/fax", async (req, res) => {
  const raw = String(req.body?.fax ?? "").trim();
  if (!raw) {
    res.json({ valid: true, normalized: null });
    return;
  }
  const { normalizeFaxNumber } = await import("../lib/fax/normalize");
  const norm = normalizeFaxNumber(raw);
  if (!norm.ok) {
    res.json({ valid: false, message: norm.message });
    return;
  }
  res.json({ valid: true, normalized: norm.e164 });
});

router.post("/validate/email", (req, res) => {
  const { email } = req.body ?? {};
  res.json(validateEmail(email));
});

router.post("/validate/address", (req, res) => {
  res.json(validateAddress(req.body ?? {}));
});

router.get("/embed/:tortId", async (req, res) => {
  const tortId = String(req.params.tortId);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) {
      badRequest(res, "Invalid host");
      return;
    }
    const config = await getFormConfig(tortId);
    if (!config || !config.active) {
      notFound(res, "Tort campaign not found");
      return;
    }
    const webFields = config.web_form_config?.fields ?? [];
    const fieldConditions: Record<string, { field: string; op: string; value: string | number | string[] }> = {};
    for (const f of webFields) {
      if (f.show_if) fieldConditions[f.key] = { field: f.show_if.field, op: f.show_if.op, value: f.show_if.value };
    }
    const multiStep = webFields.some((f) => (f.step ?? 0) > 1) || Object.keys(fieldConditions).length > 0;
    const embedScript = generateEmbedScript(
      tortId,
      {
        label: config.label,
        extra_fields: config.extra_fields,
        exposure_fields: config.exposure_fields,
        intro_text: config.intro_text,
        custom_fields: config.custom_fields,
        multi_step: multiStep,
        field_conditions: fieldConditions,
      },
      baseUrl,
    );
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.send(embedScript);
  } catch (err) {
    logger.error({ err }, "Failed to generate embed script");
    serverError(res, "Failed to generate embed script");
  }
});

export default router;
