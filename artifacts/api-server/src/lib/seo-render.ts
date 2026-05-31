// Shared server-side rendering for the public SEO page network (Task #130).
//
// The Site Maker (Task #129) produces the indexable *conversion* surfaces
// (landing `/c/:cat/:slug`, intake `/intake/:slug`). This module renders the
// surrounding *SEO* surfaces — per-tort supporting topical pages, the six
// category hubs, a glossary, a how-it-works page, plus sitemap/robots — and the
// shared chrome (head metadata, JSON-LD, breadcrumbs, hub-and-spoke nav/footer)
// that makes every public page crawlable and internally linked.
//
// HARD RULE: every fact rendered here is pulled from the DB-backed tort registry
// (FormConfigPublic + TORT_REGISTRY). No tort facts are invented. Diagnoses come
// from `valid_diagnoses`, exposure from `required_exposure`/`exposure_fields`,
// the filing window from `sol_months`, and symptom/severity/diagnosis-year copy
// from the published `web_form_config` field labels & options.

import type { Response } from "express";
import type { WebFormConfig, WebFormField } from "@workspace/db";
import type { FormConfigPublic } from "./form-config-service";
import { htmlEscape, NOT_A_LAW_FIRM_DISCLAIMER } from "./site-render";

// og:site_name + visible brand. The whole system renders `[COMPANY]` as the
// to-be-replaced brand token (see NOT_A_LAW_FIRM_DISCLAIMER), so we stay
// consistent with that placeholder convention everywhere.
export const SEO_BRAND = "[COMPANY]";

// Human labels + short, generic (non-tort-specific) blurbs for the six
// canonical categories. The blurbs describe the *category* of litigation, not
// any individual claim outcome, so they introduce no invented per-tort facts.
export const CATEGORY_LABELS: Record<string, string> = {
  pharmaceutical: "Pharmaceutical",
  product_liability: "Product Liability",
  medical_device: "Medical Device",
  environmental: "Environmental",
  transportation: "Transportation",
  digital_platform: "Digital Platform",
};

export const CATEGORY_BLURBS: Record<string, string> = {
  pharmaceutical:
    "Claims involving prescription and over-the-counter drugs alleged to have caused serious injury.",
  product_liability:
    "Claims involving consumer products alleged to be defective or unreasonably dangerous.",
  medical_device:
    "Claims involving implanted or medical devices alleged to have caused harm.",
  environmental:
    "Claims involving exposure to contaminated water, soil, or other environmental hazards.",
  transportation:
    "Claims arising from vehicle, rideshare, and other transportation-related incidents.",
  digital_platform:
    "Claims involving online platforms and technology alleged to have caused harm.",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

// ── grounded text helpers ────────────────────────────────────────────────────

// A handful of medical acronyms that appear lowercase in `valid_diagnoses` and
// should stay uppercase when displayed.
const DX_ACRONYMS = new Set([
  "nhl", "dlbcl", "cll", "aml", "ndma", "tbi", "gi", "ards", "copd", "ptsd",
  "ocd", "als", "ckd", "uti",
]);

function prettyDiagnosis(d: string): string {
  return d
    .split(/\s+/)
    .map((w) => {
      const lower = w.toLowerCase();
      if (DX_ACRONYMS.has(lower)) return lower.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/** De-dupe (case-insensitive) and prettify the registry diagnosis list. */
export function uniqueDiagnoses(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const t = raw.trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(prettyDiagnosis(t));
  }
  return out;
}

/** Convert `sol_months` into human text (e.g. 24 → "2 years"). Null when unset. */
export function statuteWindowText(solMonths: number | null): string | null {
  if (!solMonths || solMonths <= 0) return null;
  const years = Math.floor(solMonths / 12);
  const months = solMonths % 12;
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} year${years > 1 ? "s" : ""}`);
  if (months > 0) parts.push(`${months} month${months > 1 ? "s" : ""}`);
  return parts.join(" ") || null;
}

/** The eligibility-section question labels — the "do these apply to you?" set. */
export function eligibilityQuestions(cfg: WebFormConfig | null, max = 12): string[] {
  if (!cfg) return [];
  return (cfg.fields ?? [])
    .filter((f: WebFormField) => f.section === "eligibility" && Boolean(f.label))
    .map((f) => f.label)
    .slice(0, max);
}

/** Severity / stage / grade option tiers, if the published form captures them. */
export function severityTiers(cfg: WebFormConfig | null): string[] {
  if (!cfg) return [];
  const re = /severit|\bstage\b|\bgrade\b/i;
  const field = (cfg.fields ?? []).find(
    (f: WebFormField) => re.test(f.key) || re.test(f.label),
  );
  return field?.options ? [...field.options] : [];
}

/** True when the published form asks for the year of diagnosis/injury. */
export function capturesDiagnosisYear(cfg: WebFormConfig | null): boolean {
  if (!cfg) return false;
  return (cfg.fields ?? []).some(
    (f: WebFormField) => /year/i.test(f.key) || /year/i.test(f.label),
  );
}

// ── JSON-LD + head ───────────────────────────────────────────────────────────

export interface BreadcrumbItem {
  name: string;
  url: string;
}

// JSON-LD lives in a `<script type="application/ld+json">` block. Such blocks
// are DATA, not executable script, so they are NOT subject to the `script-src`
// CSP directive — but we still must escape `<` so the payload can never break
// out of the element.
function jsonLdScript(obj: unknown): string {
  const json = JSON.stringify(obj).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

export function breadcrumbJsonLd(items: BreadcrumbItem[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

export function webPageJsonLd(opts: {
  name: string;
  description: string;
  url: string;
}): object {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: opts.name,
    description: opts.description,
    url: opts.url,
    isPartOf: { "@type": "WebSite", name: SEO_BRAND },
  };
}

export function faqJsonLd(items: { q: string; a: string }[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.q,
      acceptedAnswer: { "@type": "Answer", text: it.a },
    })),
  };
}

export function itemListJsonLd(name: string, items: BreadcrumbItem[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      url: it.url,
    })),
  };
}

export interface SeoHead {
  /** <title> + og:title (brand suffix is appended automatically). */
  title: string;
  /** meta description + og:description. */
  description: string;
  /** Absolute canonical URL. */
  canonical: string;
  /** robots directive — defaults to "index,follow". */
  robots?: string;
  /** og:type — defaults to "website". */
  ogType?: string;
  /** Structured-data blocks emitted into <head>. */
  jsonLd?: object[];
}

// Tight CSP for the SEO surfaces — they are link-and-text only (no forms, no
// third-party scripts), so we lock everything to same-origin.
const SEO_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Headers for an indexable SEO page. Unlike the intake/landing pages (which are
 * `no-store`), these marketing pages are safe to cache briefly — a short
 * max-age keeps soft-deletes near-instant (a deactivated tort 404s within the
 * window) while still letting CDNs/crawlers cache.
 */
export function setSeoHeaders(res: Response, maxAgeSeconds = 300): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", `public, max-age=${maxAgeSeconds}`);
  res.setHeader("Content-Security-Policy", SEO_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
}

// ── chrome (nav, breadcrumb, related links, footer) ──────────────────────────

const SEO_STYLES = `
  :root{--ink:#0f172a;--muted:#64748b;--brand:#1d4ed8;--brand-dark:#1e3a8a;--bg:#f8fafc;--line:#e2e8f0}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;color:var(--ink);background:var(--bg);line-height:1.6}
  a{color:var(--brand)}
  .topnav{background:#fff;border-bottom:1px solid var(--line)}
  .topnav .inner{max-width:960px;margin:0 auto;padding:12px 20px;display:flex;flex-wrap:wrap;align-items:center;gap:14px}
  .topnav .brand{font-weight:800;color:var(--ink);text-decoration:none;font-size:16px;margin-right:auto}
  .topnav a.nav{font-size:13px;font-weight:600;color:var(--muted);text-decoration:none}
  .topnav a.nav:hover{color:var(--brand)}
  .wrap{max-width:760px;margin:0 auto;padding:20px 20px 80px}
  .crumbs{font-size:12px;color:var(--muted);margin:6px 0 18px;word-break:break-word}
  .crumbs a{color:var(--muted);text-decoration:none}
  .crumbs a:hover{color:var(--brand)}
  .crumbs .sep{margin:0 6px;color:#cbd5e1}
  .eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:700;color:var(--brand)}
  h1{font-size:30px;line-height:1.2;margin:8px 0 12px}
  h2{font-size:21px;margin:32px 0 12px}
  h3{font-size:17px;margin:20px 0 8px}
  .sub{font-size:17px;color:var(--muted);margin:0 0 20px}
  p{margin:12px 0}
  .strip{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}
  .chip{background:#fff;border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13px;font-weight:600;color:var(--ink)}
  ul.checklist{list-style:none;padding:0;margin:12px 0}
  ul.checklist li{padding:8px 0 8px 30px;position:relative;border-bottom:1px solid var(--line)}
  ul.checklist li:before{content:"\\2713";position:absolute;left:0;top:8px;color:#16a34a;font-weight:800}
  ul.plain{padding-left:20px;margin:12px 0}
  ul.plain li{margin:6px 0}
  ol.steps{padding-left:20px;margin:12px 0}
  ol.steps li{margin:10px 0}
  .cta{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;font-weight:700;padding:13px 24px;border-radius:10px;font-size:16px}
  .cta:hover{background:var(--brand-dark)}
  .cardgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin:16px 0}
  .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;text-decoration:none;color:var(--ink);display:block}
  .card:hover{border-color:var(--brand)}
  .card .t{font-weight:700;margin-bottom:4px}
  .card .d{font-size:13px;color:var(--muted)}
  .related{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:28px 0}
  .related .h{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:8px}
  .related ul{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:8px 18px}
  .related a{font-size:14px;font-weight:600;text-decoration:none}
  .qa{border-top:1px solid var(--line);padding:14px 0}
  .qa .q{font-weight:700}
  .qa .a{color:var(--muted)}
  .disclaimer{color:var(--muted);font-size:12px;margin-top:28px;border-top:1px solid var(--line);padding-top:16px}
  .footer{background:#fff;border-top:1px solid var(--line);margin-top:40px}
  .footer .inner{max-width:960px;margin:0 auto;padding:22px 20px}
  .footer nav{display:flex;flex-wrap:wrap;gap:8px 18px;margin-bottom:14px}
  .footer a{font-size:13px;font-weight:600;color:var(--muted);text-decoration:none}
  .footer a:hover{color:var(--brand)}
  .footer .fine{color:var(--muted);font-size:12px}
`;

/** The category-hub + utility links shown in the top nav and footer. */
function navLinks(baseUrl: string): BreadcrumbItem[] {
  const cats = Object.keys(CATEGORY_LABELS).map((c) => ({
    name: categoryLabel(c),
    url: `${baseUrl}/c/${c}`,
  }));
  return [
    ...cats,
    { name: "How it works", url: `${baseUrl}/how-it-works` },
    { name: "Glossary", url: `${baseUrl}/glossary` },
  ];
}

function topNavHtml(baseUrl: string): string {
  const links = navLinks(baseUrl)
    .map((l) => `<a class="nav" href="${htmlEscape(l.url)}">${htmlEscape(l.name)}</a>`)
    .join("");
  return `<header class="topnav"><div class="inner">
  <a class="brand" href="${htmlEscape(baseUrl)}/how-it-works">${htmlEscape(SEO_BRAND)}</a>
  ${links}
</div></header>`;
}

function footerHtml(baseUrl: string): string {
  const links = navLinks(baseUrl)
    .map((l) => `<a href="${htmlEscape(l.url)}">${htmlEscape(l.name)}</a>`)
    .join("");
  return `<footer class="footer"><div class="inner">
  <nav>${links}</nav>
  <p class="fine">${htmlEscape(NOT_A_LAW_FIRM_DISCLAIMER)}</p>
</div></footer>`;
}

/** Visible breadcrumb trail (pair with breadcrumbJsonLd in the head). */
export function breadcrumbHtml(items: BreadcrumbItem[]): string {
  return (
    `<nav class="crumbs" aria-label="Breadcrumb">` +
    items
      .map((it, i) => {
        const last = i === items.length - 1;
        const link = last
          ? `<span>${htmlEscape(it.name)}</span>`
          : `<a href="${htmlEscape(it.url)}">${htmlEscape(it.name)}</a>`;
        return i === 0 ? link : `<span class="sep">/</span>${link}`;
      })
      .join("") +
    `</nav>`
  );
}

/** A "related pages" block — the spoke links that keep the network connected. */
export function relatedHtml(title: string, links: BreadcrumbItem[]): string {
  if (links.length === 0) return "";
  const items = links
    .map((l) => `<li><a href="${htmlEscape(l.url)}">${htmlEscape(l.name)} →</a></li>`)
    .join("");
  return `<div class="related"><div class="h">${htmlEscape(title)}</div><ul>${items}</ul></div>`;
}

/** Footer disclaimer paragraph (in-content, above the site footer). */
export function disclaimerHtml(): string {
  return `<p class="disclaimer">${htmlEscape(NOT_A_LAW_FIRM_DISCLAIMER)}</p>`;
}

/**
 * Full SEO page document — head metadata + JSON-LD, top nav, body, site footer.
 * The nav and footer both link every category hub + how-it-works + glossary, so
 * every rendered page satisfies the hub-and-spoke "links into ≥2 other pages"
 * requirement automatically.
 */
export function seoPageShell(head: SeoHead, baseUrl: string, body: string): string {
  const robots = head.robots ?? "index,follow";
  const ogType = head.ogType ?? "website";
  const titleWithBrand = `${head.title} | ${SEO_BRAND}`;
  const jsonLdHtml = (head.jsonLd ?? []).map(jsonLdScript).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${htmlEscape(titleWithBrand)}</title>
<meta name="description" content="${htmlEscape(head.description)}" />
<meta name="robots" content="${htmlEscape(robots)}" />
<link rel="canonical" href="${htmlEscape(head.canonical)}" />
<meta property="og:type" content="${htmlEscape(ogType)}" />
<meta property="og:title" content="${htmlEscape(head.title)}" />
<meta property="og:description" content="${htmlEscape(head.description)}" />
<meta property="og:url" content="${htmlEscape(head.canonical)}" />
<meta property="og:site_name" content="${htmlEscape(SEO_BRAND)}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${htmlEscape(head.title)}" />
<meta name="twitter:description" content="${htmlEscape(head.description)}" />
${jsonLdHtml}
<style>${SEO_STYLES}</style>
</head>
<body>
${topNavHtml(baseUrl)}
${body}
${footerHtml(baseUrl)}
</body>
</html>`;
}

// ── grounded content builders for the supporting topical pages ────────────────

/** A clamped meta-description string (registry-grounded), <=160 chars. */
export function clampDescription(s: string, max = 158): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** FAQ items for a tort, grounded entirely in its registry record. */
export function buildTortFaq(config: FormConfigPublic): { q: string; a: string }[] {
  const label = config.label;
  const dx = uniqueDiagnoses(config.valid_diagnoses);
  const dxShort = dx.slice(0, 4).join(", ");
  const dxAll = dx.join(", ");
  const statute = statuteWindowText(config.sol_months);
  const items: { q: string; a: string }[] = [];

  items.push({
    q: `Who may qualify for a ${label} claim?`,
    a:
      `Generally, people who ${config.required_exposure ? "had documented exposure and " : ""}` +
      `were later diagnosed with a qualifying condition` +
      (dxShort ? ` such as ${dxShort}` : "") +
      `. A free, no-obligation review confirms whether your situation may fit.`,
  });

  if (dxAll) {
    items.push({
      q: `What diagnoses are reviewed for ${label} claims?`,
      a: `The conditions reviewed for ${label} claims include: ${dxAll}.`,
    });
  }

  items.push({
    q: `Is there a deadline to file a ${label} claim?`,
    a: statute
      ? `Filing deadlines (statutes of limitations) can be as short as ${statute} from diagnosis ` +
        `or from when the injury was discovered, and they vary by state. Acting promptly helps protect your rights.`
      : `Filing deadlines (statutes of limitations) vary by state and by when the injury was ` +
        `discovered. Acting promptly helps protect your rights.`,
  });

  if (config.required_exposure) {
    items.push({
      q: `Do I need proof of exposure for a ${label} claim?`,
      a:
        `For ${label}, documented exposure is part of the review. We can help you identify the ` +
        `records and details that may establish it.`,
    });
  }

  items.push({
    q: `How much does a case review cost?`,
    a: `Nothing. Case reviews are free and there are no fees unless a recovery is made.`,
  });

  items.push({
    q: `Is ${SEO_BRAND} a law firm?`,
    a: NOT_A_LAW_FIRM_DISCLAIMER,
  });

  return items;
}

// ── glossary (static, domain-level definitions — no per-tort facts) ───────────

export interface GlossaryTerm {
  term: string;
  slug: string;
  definition: string;
}

export const GLOSSARY_TERMS: readonly GlossaryTerm[] = Object.freeze([
  {
    term: "Mass tort",
    slug: "mass-tort",
    definition:
      "A legal action where many people who were harmed in a similar way by the same product, drug, or event bring individual claims that are handled together for efficiency.",
  },
  {
    term: "Multidistrict litigation (MDL)",
    slug: "mdl",
    definition:
      "A federal procedure that consolidates many similar lawsuits before one judge for pretrial proceedings, while each case keeps its own facts and outcome.",
  },
  {
    term: "Statute of limitations",
    slug: "statute-of-limitations",
    definition:
      "The legal deadline for filing a claim. It varies by state and claim type, and missing it can permanently bar a case.",
  },
  {
    term: "Discovery rule",
    slug: "discovery-rule",
    definition:
      "A principle that can start the filing deadline when an injury (or its cause) was discovered, rather than when the exposure occurred.",
  },
  {
    term: "Plaintiff",
    slug: "plaintiff",
    definition:
      "The person who brings a claim alleging they were harmed and seeking compensation.",
  },
  {
    term: "Eligibility (qualification)",
    slug: "eligibility",
    definition:
      "Whether a person's situation — typically exposure and a qualifying diagnosis within the filing window — fits the criteria for a particular claim.",
  },
  {
    term: "Exposure",
    slug: "exposure",
    definition:
      "Contact with the product, drug, or substance alleged to have caused harm. Some claims require documented exposure as part of the review.",
  },
  {
    term: "Settlement",
    slug: "settlement",
    definition:
      "A resolution of a claim by agreement rather than a trial verdict. Amounts depend on the individual facts of each case.",
  },
  {
    term: "Contingency fee",
    slug: "contingency-fee",
    definition:
      "A fee arrangement in which legal fees are owed only if there is a recovery, typically as a percentage of that recovery.",
  },
  {
    term: "Bellwether trial",
    slug: "bellwether-trial",
    definition:
      "A representative test case tried within an MDL to help the parties gauge how similar claims might be valued or resolved.",
  },
  {
    term: "Class action",
    slug: "class-action",
    definition:
      "A single lawsuit brought on behalf of a group with nearly identical claims — distinct from a mass tort, where each person's claim is evaluated individually.",
  },
  {
    term: "TCPA consent",
    slug: "tcpa-consent",
    definition:
      "Permission a person gives to be contacted, as governed by the Telephone Consumer Protection Act. It is recorded at intake before any outreach.",
  },
]);
