// Public SSR router for the Site Maker Engine.
//
//   GET /intake/:slug        — server-rendered intake page. Carries the
//                              verbatim canonical header block and embeds the
//                              EXISTING web-forms pipeline (embed.js + submit).
//                              Returns a clean 403 "intake closed" page when
//                              the form is disabled / the site is soft-deleted.
//   GET /c/:category/:slug    — server-rendered landing page (hero, eligibility
//                              checklist, trust strip, 3-step, sticky CTA →
//                              intake). Hidden (404) when the site is inactive.
//
// This router is PUBLIC (markPublic) — no JWT. It must be mounted BEFORE the
// SPA fallback in app.ts so /intake and /c never fall through to the React app.
// The /intake and /c path prefixes are registered to the api-server artifact
// (artifact.toml services.paths) so the proxy routes them here, not to the SPA.

import { Router, type Request } from "express";
import { getFormConfig } from "../lib/form-config-service";
import { markPublic } from "../lib/route-protection";
import { logger } from "../lib/logger";
import type { WebFormConfig, WebFormField } from "@workspace/db";

const router = Router();

// ── canonical guardrail copy (LOCKED — appears on every generated page) ───────
// Not-a-law-firm positioning + [COMPANY] disclaimer. Rendered in the footer of
// every page and directly above the intake form's submit area.
const NOT_A_LAW_FIRM_DISCLAIMER =
  "[COMPANY] is not a law firm and does not provide legal advice, legal " +
  "representation, or referrals in exchange for any payment. Submitting this " +
  "form does not create an attorney–client relationship. This is attorney " +
  "advertising. Past results do not guarantee a similar outcome. You may be " +
  "contacted by a participating attorney or their representative regarding " +
  "your potential claim. There is no cost or obligation to you.";

// Verbatim intake header block — the EXACT "Intake Forms / HIPAA-safe…" copy
// that every generated intake page must carry.
const INTAKE_HEADER_EYEBROW = "Secure Intake Form";
const INTAKE_HEADER_TRUST =
  "🔒 HIPAA-safe, encrypted intake — your information is transmitted securely " +
  "and reviewed confidentially. We never sell your data.";

// Strict host pattern: alphanumerics, dot, hyphen, optional :port.
const SAFE_HOST = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

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

function htmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

// CSP for the generated public pages. The inline <script src> points back at
// our own embed.js endpoint (same origin), so 'self' is sufficient.
const PUBLIC_CSP = [
  "default-src 'self'",
  "script-src 'self' https://api.trustedform.com https://*.trustedform.com",
  "worker-src 'self' blob: https://*.trustedform.com",
  "frame-src 'self' https://*.trustedform.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://api.trustedform.com https://*.trustedform.com",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${htmlEscape(title)}</title>
<style>
  :root{--ink:#0f172a;--muted:#64748b;--brand:#1d4ed8;--brand-dark:#1e3a8a;--bg:#f8fafc;--line:#e2e8f0}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;color:var(--ink);background:var(--bg);line-height:1.6}
  .wrap{max-width:760px;margin:0 auto;padding:24px 20px 96px}
  .eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:700;color:var(--brand)}
  h1{font-size:30px;line-height:1.2;margin:8px 0 12px}
  h2{font-size:20px;margin:32px 0 12px}
  .sub{font-size:17px;color:var(--muted);margin:0 0 20px}
  .trust{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:10px;padding:12px 16px;font-size:14px;margin:18px 0}
  .strip{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}
  .chip{background:#fff;border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13px;font-weight:600;color:var(--ink)}
  ul.checklist{list-style:none;padding:0;margin:12px 0}
  ul.checklist li{padding:8px 0 8px 30px;position:relative;border-bottom:1px solid var(--line)}
  ul.checklist li:before{content:"✓";position:absolute;left:0;top:8px;color:#16a34a;font-weight:800}
  ol.steps{padding-left:20px;margin:12px 0}
  ol.steps li{margin:8px 0}
  .cta{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:10px;font-size:16px}
  .cta:hover{background:var(--brand-dark)}
  .sticky{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--line);padding:12px 16px;display:flex;justify-content:center;box-shadow:0 -4px 16px rgba(0,0,0,.06);z-index:20}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:24px;margin-top:18px}
  .disclaimer{color:var(--muted);font-size:12px;margin-top:28px;border-top:1px solid var(--line);padding-top:16px}
  .above-submit{color:var(--muted);font-size:12px;margin:16px 0;background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  #mtos-web-form{margin-top:8px}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function disclaimerHtml(): string {
  return `<p class="disclaimer">${htmlEscape(NOT_A_LAW_FIRM_DISCLAIMER)}</p>`;
}

function setPublicHeaders(res: import("express").Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", PUBLIC_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

// Pull the eligibility-section custom fields to build the landing checklist.
// We surface the field LABELS (the qualifying questions) as checklist items.
function eligibilityChecklistItems(cfg: WebFormConfig): string[] {
  const fields: WebFormField[] = cfg.fields ?? [];
  return fields
    .filter(f => f.section === "eligibility" && f.label)
    .map(f => f.label)
    .slice(0, 8);
}

// ── GET /intake/:slug — intake page (verbatim header + embedded pipeline) ─────
router.get("/intake/:slug", async (req, res) => {
  const slug = String(req.params.slug);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) {
      res.status(400).type("html").send(pageShell("Bad request", `<div class="wrap"><h1>Bad request</h1></div>`));
      return;
    }
    const config = await getFormConfig(slug);
    const cfg = config?.web_form_config;
    const live = Boolean(config?.active && cfg?.enabled);

    if (!config || !live) {
      // Clean 403 "intake closed" page (distinct from the embed-submit 404 used
      // for anti-enumeration on the API itself).
      const body = `<div class="wrap">
  <span class="eyebrow">${htmlEscape(INTAKE_HEADER_EYEBROW)}</span>
  <h1>This intake is currently closed</h1>
  <p class="sub">We're not accepting new submissions for this campaign right now. If you believe you may have a claim, please check back later.</p>
  ${disclaimerHtml()}
</div>`;
      res.status(403);
      setPublicHeaders(res);
      res.send(pageShell("Intake closed", body));
      return;
    }

    const safeSlug = encodeURIComponent(slug);
    const headline = cfg!.intro_headline || config.label;
    const subhead = cfg!.intro_subhead || `Tell us about your potential ${config.label} claim.`;

    const body = `<div class="wrap">
  <span class="eyebrow">${htmlEscape(INTAKE_HEADER_EYEBROW)}</span>
  <h1>${htmlEscape(headline)}</h1>
  <p class="sub">${htmlEscape(subhead)}</p>
  <div class="trust">${htmlEscape(INTAKE_HEADER_TRUST)}</div>
  <div class="card">
    <div id="mtos-web-form"></div>
    <p class="above-submit">${htmlEscape(NOT_A_LAW_FIRM_DISCLAIMER)}</p>
  </div>
  ${disclaimerHtml()}
</div>
<script src="${htmlEscape(baseUrl)}/api/web-forms/${safeSlug}/embed.js"></script>`;

    setPublicHeaders(res);
    res.send(pageShell(`${headline} — Intake`, body));
  } catch (err) {
    logger.error({ err, slug }, "Failed to render intake page");
    res.status(500).type("html").send(pageShell("Error", `<div class="wrap"><h1>Something went wrong</h1></div>`));
  }
});

// ── GET /c/:category/:slug — landing page ─────────────────────────────────────
router.get("/c/:category/:slug", async (req, res) => {
  const category = String(req.params.category);
  const slug = String(req.params.slug);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) {
      res.status(400).type("html").send(pageShell("Bad request", `<div class="wrap"><h1>Bad request</h1></div>`));
      return;
    }
    const config = await getFormConfig(slug);
    // Landing is hidden when the row is inactive (soft-deleted) or the category
    // in the URL doesn't match the site's actual category.
    if (!config || !config.active || config.category !== category) {
      res.status(404);
      setPublicHeaders(res);
      res.send(pageShell("Not found", `<div class="wrap"><h1>Page not found</h1><p class="sub">This campaign is not available.</p>${disclaimerHtml()}</div>`));
      return;
    }

    const cfg = config.web_form_config;
    const safeSlug = encodeURIComponent(slug);
    const intakeUrl = `${baseUrl}/intake/${safeSlug}`;
    const headline = cfg?.intro_headline || config.label;
    const subhead = cfg?.intro_subhead || `See if you may qualify for a ${config.label} claim.`;
    const checklist = cfg ? eligibilityChecklistItems(cfg) : [];

    const checklistHtml = checklist.length > 0
      ? `<h2>Do any of these apply to you?</h2>
  <ul class="checklist">${checklist.map(i => `<li>${htmlEscape(i)}</li>`).join("")}</ul>`
      : "";

    const ctaDisabled = !(config.active && cfg?.enabled);
    const ctaHtml = ctaDisabled
      ? `<span class="chip">Intake currently closed</span>`
      : `<a class="cta" href="${htmlEscape(intakeUrl)}">Check if you qualify →</a>`;

    const body = `<div class="wrap">
  <span class="eyebrow">${htmlEscape(config.label)}</span>
  <h1>${htmlEscape(headline)}</h1>
  <p class="sub">${htmlEscape(subhead)}</p>
  <div>${ctaHtml}</div>

  <div class="strip">
    <span class="chip">✓ Free case review</span>
    <span class="chip">✓ No fees unless you win</span>
    <span class="chip">✓ Confidential &amp; secure</span>
  </div>

  ${checklistHtml}

  <h2>How it works</h2>
  <ol class="steps">
    <li><strong>Tell us what happened</strong> — answer a few quick, secure questions.</li>
    <li><strong>We review your information</strong> — a case manager evaluates your potential claim.</li>
    <li><strong>Talk to someone</strong> — we contact you within one business day with next steps.</li>
  </ol>

  ${disclaimerHtml()}
</div>
${ctaDisabled ? "" : `<div class="sticky"><a class="cta" href="${htmlEscape(intakeUrl)}">Check if you qualify →</a></div>`}`;

    setPublicHeaders(res);
    res.send(pageShell(`${headline}`, body));
  } catch (err) {
    logger.error({ err, category, slug }, "Failed to render landing page");
    res.status(500).type("html").send(pageShell("Error", `<div class="wrap"><h1>Something went wrong</h1></div>`));
  }
});

export default markPublic(router, "public-sites");
