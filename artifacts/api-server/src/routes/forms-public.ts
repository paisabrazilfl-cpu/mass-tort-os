import { Router, type IRouter, type Request } from "express";
import rateLimit from "express-rate-limit";
import { getFormConfig } from "../lib/form-config-service";
import { generateEmbedScript } from "./forms";
import { logger } from "../lib/logger";
import { badRequest, notFound, serverError } from "../lib/http-errors";

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
<script src="${htmlEscape(baseUrl)}/api/forms/embed/${safeTortId}"></script>
<script src="${htmlEscape(baseUrl)}/api/forms/preview-blocker.js"></script>
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
    const embedScript = generateEmbedScript(
      tortId,
      {
        label: config.label,
        extra_fields: config.extra_fields,
        exposure_fields: config.exposure_fields,
        intro_text: config.intro_text,
        custom_fields: config.custom_fields,
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
