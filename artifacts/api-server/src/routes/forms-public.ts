import { Router, type IRouter } from "express";
import { getFormConfig } from "../lib/form-config-service";
import { generateEmbedScript } from "./forms";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/preview/:tortId", async (req, res) => {
  const tortId = req.params.tortId;
  try {
    const config = await getFormConfig(tortId);
    if (!config) {
      res.status(404).type("html").send("<h1>Form not found</h1>");
      return;
    }
    const host = req.get("host") || "localhost";
    const protocol = req.get("x-forwarded-proto") || req.protocol;
    const baseUrl = `${protocol}://${host}`;
    const safeLabel = config.label.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] as string);
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
<script src="${baseUrl}/api/forms/embed/${encodeURIComponent(tortId)}"></script>
<script src="${baseUrl}/api/forms/preview-blocker.js"></script>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://api.trustedform.com https://*.trustedform.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://api.trustedform.com https://*.trustedform.com; frame-ancestors *",
    );
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
  const tortId = req.params.tortId;
  try {
    const config = await getFormConfig(tortId);
    if (!config || !config.active) {
      res.status(404).json({ error: "Tort campaign not found" });
      return;
    }
    const host = req.get("host") || "localhost";
    const protocol = req.get("x-forwarded-proto") || req.protocol;
    const baseUrl = `${protocol}://${host}`;
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
    res.status(500).json({ error: "Failed to generate embed script" });
  }
});

export default router;
