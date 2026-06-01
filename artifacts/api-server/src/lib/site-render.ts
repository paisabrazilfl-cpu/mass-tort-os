// Shared server-side HTML rendering for the Site Maker Engine.
//
// Single source of truth for the canonical public-page chrome (page shell,
// not-a-law-firm disclaimer, verbatim intake header block, eligibility
// checklist) so the PUBLIC SSR pages (`routes/public-sites.ts`) and the
// in-CRM DRAFT preview (`POST /api/sites/preview`) render identically. The
// public intake page mounts the live `embed.js` form; the draft preview can't
// (no DB row exists yet), so it server-renders the same canonical fields as a
// static, read-only mirror of what will go live on publish.

import type { Request, Response } from "express";
import type { WebFormConfig, WebFormField, SiteProfile } from "@workspace/db";

// ── canonical guardrail copy (LOCKED — appears on every generated page) ───────
// Not-a-law-firm positioning + [COMPANY] disclaimer. Rendered in the footer of
// every page and directly above the intake form's submit area.
export const NOT_A_LAW_FIRM_DISCLAIMER =
  "[COMPANY] is not a law firm and does not provide legal advice, legal " +
  "representation, or referrals in exchange for any payment. Submitting this " +
  "form does not create an attorney–client relationship. This is attorney " +
  "advertising. Past results do not guarantee a similar outcome. You may be " +
  "contacted by a participating attorney or their representative regarding " +
  "your potential claim. There is no cost or obligation to you.";

// Verbatim intake header block — the EXACT "Intake Forms / HIPAA-safe…" copy
// that every generated intake page must carry.
export const INTAKE_HEADER_EYEBROW = "Secure Intake Form";
export const INTAKE_HEADER_TRUST =
  "🔒 HIPAA-safe, encrypted intake — your information is transmitted securely " +
  "and reviewed confidentially. We never sell your data.";

// CSP for the generated public pages. The inline <script src> points back at
// our own embed.js endpoint (same origin), so 'self' is sufficient.
export const PUBLIC_CSP = [
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

export function htmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

// ── per-tort branding (from form_configurations.site_profile) ────────────────
// Resolved, render-ready branding for the public page shells. Colors are
// sanitized to a safe CSS-token whitelist; image URLs are absolutized against
// the request base so they satisfy the pages' same-origin `img-src` CSP.
export interface ShellBranding {
  primary?: string;
  primaryDark?: string;
  faviconUrl?: string;
  ogImageUrl?: string;
  heroUrl?: string;
  brandName?: string;
}

// Only allow hex, simple named colors, or rgb()/hsl() — never arbitrary text,
// so a profile value can't break out of the `<style>` block (CSS injection).
function safeColor(v?: string): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s;
  if (/^(rgb|hsl)a?\([0-9.,%\s/]+\)$/i.test(s)) return s;
  return undefined;
}

export function brandingFromProfile(
  profile: SiteProfile | null | undefined,
  baseUrl: string,
): ShellBranding | undefined {
  if (!profile) return undefined;
  const base = baseUrl.replace(/\/+$/, "");
  const abs = (u?: string): string | undefined => {
    if (!u) return undefined;
    if (/^https?:\/\//i.test(u)) return u;
    return `${base}${u.startsWith("/") ? "" : "/"}${u}`;
  };
  const b: ShellBranding = {
    primary: safeColor(profile.colors?.primary),
    primaryDark: safeColor(profile.colors?.primary_dark),
    faviconUrl: abs(profile.images?.favicon),
    ogImageUrl: abs(profile.images?.og),
    heroUrl: abs(profile.images?.hero),
    brandName: profile.brand_name,
  };
  if (!b.primary && !b.primaryDark && !b.faviconUrl && !b.ogImageUrl && !b.heroUrl) {
    return undefined;
  }
  return b;
}

// Extra <head> tags injected when branding is present: favicon + social image.
export function brandingHeadTags(b?: ShellBranding): string {
  if (!b) return "";
  const tags: string[] = [];
  if (b.faviconUrl) tags.push(`<link rel="icon" href="${htmlEscape(b.faviconUrl)}" />`);
  if (b.ogImageUrl) {
    tags.push(`<meta property="og:image" content="${htmlEscape(b.ogImageUrl)}" />`);
    tags.push(`<meta name="twitter:card" content="summary_large_image" />`);
    tags.push(`<meta name="twitter:image" content="${htmlEscape(b.ogImageUrl)}" />`);
  }
  return tags.length ? "\n" + tags.join("\n") : "";
}

// :root color overrides — must be emitted AFTER the base <style> to win.
export function brandingRootStyle(b?: ShellBranding): string {
  if (!b || (!b.primary && !b.primaryDark)) return "";
  const decls: string[] = [];
  if (b.primary) decls.push(`--brand:${b.primary}`);
  if (b.primaryDark) decls.push(`--brand-dark:${b.primaryDark}`);
  return `\n<style>:root{${decls.join(";")}}</style>`;
}

export function pageShell(title: string, body: string, branding?: ShellBranding): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${htmlEscape(title)}</title>${brandingHeadTags(branding)}
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
  .sect{margin:18px 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .field{margin:12px 0}
  .field label{display:block;font-size:14px;font-weight:600;margin-bottom:4px}
  .field .req{color:#dc2626;margin-left:2px}
  .field input,.field select,.field textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:#f8fafc;color:var(--muted)}
  .field .help{font-size:12px;color:var(--muted);margin-top:4px}
  .field .opt{display:flex;align-items:center;gap:8px;font-size:14px;margin:4px 0;color:var(--ink)}
  .preview-note{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:10px;padding:10px 14px;font-size:13px;margin:14px 0}
  .submit-mock{display:inline-block;background:var(--brand);color:#fff;font-weight:700;padding:12px 24px;border-radius:10px;font-size:15px;opacity:.65}
</style>${brandingRootStyle(branding)}
</head>
<body>
${body}
</body>
</html>`;
}

export function disclaimerHtml(): string {
  return `<p class="disclaimer">${htmlEscape(NOT_A_LAW_FIRM_DISCLAIMER)}</p>`;
}

// Strict host pattern: alphanumerics, dot, hyphen, optional :port.
const SAFE_HOST = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

/**
 * Resolve the absolute base URL (scheme + host) for an incoming request, used
 * to build canonical/OG URLs and sitemap entries. Prefers the configured
 * PUBLIC_API_BASE_URL; otherwise derives it from the (validated) Host header
 * and forwarded proto. Returns null when the host/proto can't be trusted.
 */
export function resolveBaseUrl(req: Request): string | null {
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

export function setPublicHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", PUBLIC_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

// Pull the eligibility-section custom fields to build the landing checklist.
// We surface the field LABELS (the qualifying questions) as checklist items.
export function eligibilityChecklistItems(cfg: WebFormConfig): string[] {
  const fields: WebFormField[] = cfg.fields ?? [];
  return fields
    .filter((f) => f.section === "eligibility" && f.label)
    .map((f) => f.label)
    .slice(0, 8);
}

// ── draft preview — static, read-only render of the canonical form ───────────
const SECTION_TITLES: Record<string, string> = {
  eligibility: "Eligibility",
  contact: "Your contact details",
  story: "Your story",
};

function renderPreviewField(f: WebFormField): string {
  const label = `<label>${htmlEscape(f.label)}${f.required ? '<span class="req">*</span>' : ""}</label>`;
  const help = f.helper_text ? `<div class="help">${htmlEscape(f.helper_text)}</div>` : "";
  const ph = f.placeholder ? ` placeholder="${htmlEscape(f.placeholder)}"` : "";
  let control: string;
  switch (f.type) {
    case "textarea":
      control = `<textarea rows="3" disabled${ph}></textarea>`;
      break;
    case "select":
    case "state": {
      const opts = (f.options ?? []).map((o) => `<option>${htmlEscape(o)}</option>`).join("");
      control = `<select disabled><option>Select…</option>${opts}</select>`;
      break;
    }
    case "radio": {
      const opts = (f.options ?? [])
        .map((o) => `<div class="opt"><input type="radio" disabled /> ${htmlEscape(o)}</div>`)
        .join("");
      control = opts || `<div class="opt"><input type="radio" disabled /> Yes</div>`;
      break;
    }
    case "checkbox":
      control = `<div class="opt"><input type="checkbox" disabled /> ${htmlEscape(f.label)}</div>`;
      break;
    case "number":
      control = `<input type="number" disabled${ph} />`;
      break;
    case "date":
      control = `<input type="date" disabled${ph} />`;
      break;
    case "email":
      control = `<input type="email" disabled${ph} />`;
      break;
    case "tel":
      control = `<input type="tel" disabled${ph} />`;
      break;
    default:
      control = `<input type="text" disabled${ph} />`;
  }
  // For a checkbox the label is rendered inline with the control.
  const body = f.type === "checkbox" ? control : `${label}${control}`;
  return `<div class="field">${body}${help}</div>`;
}

function renderPreviewFieldsHtml(cfg: WebFormConfig): string {
  const order: Array<WebFormField["section"]> = ["eligibility", "contact", "story"];
  const parts: string[] = [];
  for (const section of order) {
    const fields = (cfg.fields ?? []).filter((f) => f.section === section);
    if (fields.length === 0) continue;
    parts.push(`<div class="sect">${htmlEscape(SECTION_TITLES[section] ?? section)}</div>`);
    parts.push(fields.map(renderPreviewField).join(""));
  }
  return parts.join("");
}

/**
 * Render a full, standalone DRAFT intake preview page from an in-memory
 * canonical config (no DB row, no embed.js). Mirrors the chrome of the live
 * `/intake/:slug` page exactly — verbatim header block, canonical fields,
 * `[COMPANY]` disclaimer above the submit area and in the footer — so the
 * operator sees a faithful, route-backed preview before anything is published.
 */
export function renderDraftIntakePreviewHtml(cfg: WebFormConfig, label: string): string {
  const headline = cfg.intro_headline || label;
  const subhead = cfg.intro_subhead || `Tell us about your potential ${label} claim.`;
  const body = `<div class="wrap">
  <div class="preview-note">Draft preview — nothing is public until you publish. The live page mounts the secure interactive form in place of these read-only fields.</div>
  <span class="eyebrow">${htmlEscape(INTAKE_HEADER_EYEBROW)}</span>
  <h1>${htmlEscape(headline)}</h1>
  <p class="sub">${htmlEscape(subhead)}</p>
  <div class="trust">${htmlEscape(INTAKE_HEADER_TRUST)}</div>
  <div class="card">
    ${renderPreviewFieldsHtml(cfg)}
    <p class="above-submit">${htmlEscape(NOT_A_LAW_FIRM_DISCLAIMER)}</p>
    <span class="submit-mock">Submit my information</span>
  </div>
  ${disclaimerHtml()}
</div>`;
  return pageShell(`${headline} — Intake (preview)`, body);
}
