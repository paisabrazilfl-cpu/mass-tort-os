// Public SSR router for the SEO page network (Task #130).
//
//   GET /c/:category                 — category hub (lists live torts in the
//                                      category as cards → their landing pages).
//   GET /c/:category/:slug/:topic    — per-tort supporting topical page, where
//                                      :topic ∈ { symptoms, diagnosis, faq }.
//   GET /glossary                    — evergreen domain glossary.
//   GET /how-it-works                — evergreen process explainer.
//   GET /sitemap.xml                 — XML sitemap of every live SEO page.
//   GET /robots.txt                  — crawl policy (disallows /api + /intake).
//
// This router is PUBLIC (markPublic) — no JWT. It is mounted BEFORE the SPA
// fallback in app.ts, and its /glossary, /how-it-works, /sitemap.xml and
// /robots.txt path prefixes are registered to the api-server artifact
// (artifact.toml services.paths) so the proxy routes them here, not to the SPA.
// (/c is already registered for the landing pages in public-sites.ts.)

import { Router } from "express";
import { getAllFormConfigs, getFormConfig } from "../lib/form-config-service";
import type { FormConfigPublic } from "../lib/form-config-service";
import { markPublic } from "../lib/route-protection";
import { logger } from "../lib/logger";
import { htmlEscape, resolveBaseUrl, disclaimerHtml } from "../lib/site-render";
import {
  CATEGORY_LABELS,
  CATEGORY_BLURBS,
  GLOSSARY_TERMS,
  categoryLabel,
  clampDescription,
  uniqueDiagnoses,
  statuteWindowText,
  eligibilityQuestions,
  severityTiers,
  capturesDiagnosisYear,
  buildTortFaq,
  breadcrumbHtml,
  breadcrumbJsonLd,
  webPageJsonLd,
  faqJsonLd,
  itemListJsonLd,
  relatedHtml,
  seoPageShell,
  setSeoHeaders,
  type BreadcrumbItem,
} from "../lib/seo-render";
import { buildSeoManifest, TORT_TOPICS, type TortTopic } from "../lib/seo-pages";

const router = Router();

function isTortTopic(value: string): value is TortTopic {
  return (TORT_TOPICS as readonly string[]).includes(value);
}

function notFound(res: import("express").Response, baseUrl: string, canonical: string): void {
  res.status(404);
  setSeoHeaders(res, 0);
  res.send(
    seoPageShell(
      {
        title: "Page not found",
        description: "This page is not available.",
        canonical,
        robots: "noindex,follow",
      },
      baseUrl,
      `<div class="wrap"><h1>Page not found</h1><p class="sub">This page is not available.</p>${disclaimerHtml()}</div>`,
    ),
  );
}

function badRequest(res: import("express").Response): void {
  res.status(400).type("html").send("<h1>Bad request</h1>");
}

function homeCrumb(baseUrl: string): BreadcrumbItem {
  return { name: "Home", url: `${baseUrl}/how-it-works` };
}

// ── GET /c/:category — category hub ──────────────────────────────────────────
router.get("/c/:category", async (req, res) => {
  const category = String(req.params.category);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) return badRequest(res);
    const canonical = `${baseUrl}/c/${encodeURIComponent(category)}`;

    if (!CATEGORY_LABELS[category]) return notFound(res, baseUrl, canonical);

    const all = await getAllFormConfigs();
    const torts = all
      .filter((c) => c.active && c.category === category)
      .sort((a, b) => a.label.localeCompare(b.label));

    // Hubs are only published for non-empty categories — this mirrors
    // buildSeoManifest() exactly so the served routes never drift from the
    // sitemap/rebuild manifest. An empty category 404s instead of serving a
    // thin, unindexed page.
    if (!torts.length) return notFound(res, baseUrl, canonical);

    const label = categoryLabel(category);
    const blurb = CATEGORY_BLURBS[category] ?? "";
    const description = clampDescription(`${blurb} Browse ${label.toLowerCase()} claims we currently review for free, confidential eligibility checks.`);

    const crumbs: BreadcrumbItem[] = [homeCrumb(baseUrl), { name: `${label} claims`, url: canonical }];

    const cards = `<div class="cardgrid">${torts
      .map((c) => {
        const dxCount = uniqueDiagnoses(c.valid_diagnoses).length;
        const url = `${baseUrl}/c/${encodeURIComponent(c.category)}/${encodeURIComponent(c.id)}`;
        const d = dxCount > 0 ? `${dxCount} qualifying diagnosis${dxCount === 1 ? "" : "es"} reviewed` : "Free eligibility review";
        return `<a class="card" href="${htmlEscape(url)}"><div class="t">${htmlEscape(c.label)}</div><div class="d">${htmlEscape(d)}</div></a>`;
      })
      .join("")}</div>`;

    const listItems: BreadcrumbItem[] = torts.map((c) => ({
      name: c.label,
      url: `${baseUrl}/c/${encodeURIComponent(c.category)}/${encodeURIComponent(c.id)}`,
    }));

    const body = `<div class="wrap">
  ${breadcrumbHtml(crumbs)}
  <span class="eyebrow">${htmlEscape(label)}</span>
  <h1>${htmlEscape(label)} mass tort claims</h1>
  <p class="sub">${htmlEscape(blurb)}</p>
  ${cards}
  ${relatedHtml("Helpful resources", [
    { name: "How the process works", url: `${baseUrl}/how-it-works` },
    { name: "Mass tort glossary", url: `${baseUrl}/glossary` },
  ])}
  ${disclaimerHtml()}
</div>`;

    setSeoHeaders(res);
    res.send(
      seoPageShell(
        {
          title: `${label} mass tort claims`,
          description,
          canonical,
          jsonLd: [
            webPageJsonLd({ name: `${label} mass tort claims`, description, url: canonical }),
            breadcrumbJsonLd(crumbs),
            ...(listItems.length ? [itemListJsonLd(`${label} claims`, listItems)] : []),
          ],
        },
        baseUrl,
        body,
      ),
    );
  } catch (err) {
    logger.error({ err, category }, "Failed to render category hub");
    res.status(500).type("html").send("<h1>Something went wrong</h1>");
  }
});

// ── GET /c/:category/:slug/:topic — supporting topical page ───────────────────
router.get("/c/:category/:slug/:topic", async (req, res) => {
  const category = String(req.params.category);
  const slug = String(req.params.slug);
  const topic = String(req.params.topic);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) return badRequest(res);
    const canonical = `${baseUrl}/c/${encodeURIComponent(category)}/${encodeURIComponent(slug)}/${encodeURIComponent(topic)}`;

    if (!isTortTopic(topic)) return notFound(res, baseUrl, canonical);

    const config = await getFormConfig(slug);
    if (!config || !config.active || config.category !== category) {
      return notFound(res, baseUrl, canonical);
    }

    const safeCat = encodeURIComponent(config.category);
    const safeSlug = encodeURIComponent(config.id);
    const landingUrl = `${baseUrl}/c/${safeCat}/${safeSlug}`;
    const hubUrl = `${baseUrl}/c/${safeCat}`;
    const label = config.label;

    // Spoke links: landing + sibling topics + hub (≥2 outbound links always).
    const siblingLinks: BreadcrumbItem[] = [
      { name: `${label}: Overview & eligibility check`, url: landingUrl },
      ...TORT_TOPICS.filter((t) => t !== topic).map((t) => ({
        name: `${label}: ${TOPIC_TITLES[t]}`,
        url: `${landingUrl}/${t}`,
      })),
      { name: `${categoryLabel(config.category)} claims`, url: hubUrl },
    ];

    const { title, description, content, faqItems } = renderTopic(topic, config);

    const crumbs: BreadcrumbItem[] = [
      homeCrumb(baseUrl),
      { name: `${categoryLabel(config.category)} claims`, url: hubUrl },
      { name: label, url: landingUrl },
      { name: TOPIC_TITLES[topic], url: canonical },
    ];

    const body = `<div class="wrap">
  ${breadcrumbHtml(crumbs)}
  <span class="eyebrow">${htmlEscape(label)}</span>
  <h1>${htmlEscape(title)}</h1>
  ${content}
  <div style="margin:22px 0"><a class="cta" href="${htmlEscape(landingUrl)}">Check if you qualify →</a></div>
  ${relatedHtml(`More on ${label} claims`, siblingLinks)}
  ${disclaimerHtml()}
</div>`;

    const jsonLd: object[] = [
      webPageJsonLd({ name: title, description, url: canonical }),
      breadcrumbJsonLd(crumbs),
    ];
    if (faqItems && faqItems.length) jsonLd.push(faqJsonLd(faqItems));

    setSeoHeaders(res);
    res.send(seoPageShell({ title, description, canonical, jsonLd }, baseUrl, body));
  } catch (err) {
    logger.error({ err, category, slug, topic }, "Failed to render supporting page");
    res.status(500).type("html").send("<h1>Something went wrong</h1>");
  }
});

const TOPIC_TITLES: Record<TortTopic, string> = {
  symptoms: "Symptoms & eligibility",
  diagnosis: "Qualifying diagnoses & filing window",
  faq: "Frequently asked questions",
};

interface RenderedTopic {
  title: string;
  description: string;
  content: string;
  faqItems?: { q: string; a: string }[];
}

function renderTopic(topic: TortTopic, config: FormConfigPublic): RenderedTopic {
  const label = config.label;
  const cfg = config.web_form_config;

  if (topic === "symptoms") {
    const questions = eligibilityQuestions(cfg);
    const list = questions.length
      ? `<ul class="checklist">${questions.map((q) => `<li>${htmlEscape(q)}</li>`).join("")}</ul>`
      : `<p>Eligibility is confirmed through a short, free review of your situation.</p>`;
    const exposure = config.required_exposure
      ? `<h2>Exposure</h2><p>${htmlEscape(label)} claims involve documented exposure. During the review we help identify the details and records that may establish it.</p>`
      : "";
    const content = `<p class="sub">See the factors that typically matter when reviewing a ${htmlEscape(label)} claim.</p>
  <h2>Do any of these apply to you?</h2>
  ${list}
  ${exposure}`;
    return {
      title: `${label}: Symptoms & eligibility`,
      description: clampDescription(`Who may qualify for a ${label} claim, the eligibility factors we review, and how to start a free, confidential check.`),
      content,
    };
  }

  if (topic === "diagnosis") {
    const dx = uniqueDiagnoses(config.valid_diagnoses);
    const dxHtml = dx.length
      ? `<h2>Qualifying diagnoses</h2><ul class="plain">${dx.map((d) => `<li>${htmlEscape(d)}</li>`).join("")}</ul>`
      : "";
    const statute = statuteWindowText(config.sol_months);
    const statuteHtml = `<h2>Filing window</h2><p>${
      statute
        ? `Filing deadlines (statutes of limitations) for ${htmlEscape(label)} claims can be as short as <strong>${htmlEscape(statute)}</strong> from diagnosis or from when the injury was discovered, and they vary by state.`
        : `Filing deadlines (statutes of limitations) for ${htmlEscape(label)} claims vary by state and by when the injury was discovered.`
    } Acting promptly helps protect your rights.</p>`;
    const yearHtml = capturesDiagnosisYear(cfg)
      ? `<p>Because timing matters, the review asks for the <strong>year of diagnosis</strong> so it can be checked against the applicable filing window.</p>`
      : "";
    const tiers = severityTiers(cfg);
    const tiersHtml = tiers.length
      ? `<h2>Severity</h2><ul class="plain">${tiers.map((t) => `<li>${htmlEscape(t)}</li>`).join("")}</ul>`
      : "";
    const content = `<p class="sub">The conditions and timing we review for a ${htmlEscape(label)} claim.</p>
  ${dxHtml}
  ${statuteHtml}
  ${yearHtml}
  ${tiersHtml}`;
    return {
      title: `${label}: Qualifying diagnoses & filing window`,
      description: clampDescription(`Diagnoses reviewed for ${label} claims${dx.length ? ` (${dx.slice(0, 3).join(", ")}…)` : ""} and how filing deadlines work.`),
      content,
    };
  }

  // faq
  const faqItems = buildTortFaq(config);
  const content = `<p class="sub">Common questions about ${htmlEscape(label)} claims.</p>
  ${faqItems
    .map((it) => `<div class="qa"><div class="q">${htmlEscape(it.q)}</div><div class="a">${htmlEscape(it.a)}</div></div>`)
    .join("")}`;
  return {
    title: `${label}: Frequently asked questions`,
    description: clampDescription(`Answers to common questions about ${label} claims — who qualifies, deadlines, costs, and what to expect.`),
    content,
    faqItems,
  };
}

// ── GET /glossary — evergreen domain glossary ─────────────────────────────────
router.get("/glossary", async (req, res) => {
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) return badRequest(res);
    const canonical = `${baseUrl}/glossary`;
    const description = clampDescription("Plain-language definitions of mass tort terms — MDL, statute of limitations, eligibility, settlement, and more.");
    const crumbs: BreadcrumbItem[] = [homeCrumb(baseUrl), { name: "Glossary", url: canonical }];

    const terms = GLOSSARY_TERMS.map(
      (t) =>
        `<div class="qa" id="${htmlEscape(t.slug)}"><div class="q">${htmlEscape(t.term)}</div><div class="a">${htmlEscape(t.definition)}</div></div>`,
    ).join("");

    const hubLinks: BreadcrumbItem[] = Object.keys(CATEGORY_LABELS).map((c) => ({
      name: `${categoryLabel(c)} claims`,
      url: `${baseUrl}/c/${c}`,
    }));

    const body = `<div class="wrap">
  ${breadcrumbHtml(crumbs)}
  <span class="eyebrow">Reference</span>
  <h1>Mass tort glossary</h1>
  <p class="sub">Plain-language definitions of the terms you'll see during a claim review.</p>
  ${terms}
  ${relatedHtml("Browse claims by category", hubLinks)}
  ${disclaimerHtml()}
</div>`;

    setSeoHeaders(res, 3600);
    res.send(
      seoPageShell(
        {
          title: "Mass tort glossary",
          description,
          canonical,
          jsonLd: [webPageJsonLd({ name: "Mass tort glossary", description, url: canonical }), breadcrumbJsonLd(crumbs)],
        },
        baseUrl,
        body,
      ),
    );
  } catch (err) {
    logger.error({ err }, "Failed to render glossary");
    res.status(500).type("html").send("<h1>Something went wrong</h1>");
  }
});

// ── GET /how-it-works — evergreen process explainer ───────────────────────────
router.get("/how-it-works", async (req, res) => {
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) return badRequest(res);
    const canonical = `${baseUrl}/how-it-works`;
    const description = clampDescription("How a mass tort claim review works — a free, confidential eligibility check, what we review, and what happens next. No fees unless you win.");
    const crumbs: BreadcrumbItem[] = [{ name: "Home", url: canonical }];

    const hubLinks: BreadcrumbItem[] = Object.keys(CATEGORY_LABELS).map((c) => ({
      name: `${categoryLabel(c)} claims`,
      url: `${baseUrl}/c/${c}`,
    }));

    const body = `<div class="wrap">
  ${breadcrumbHtml(crumbs)}
  <span class="eyebrow">Getting started</span>
  <h1>How it works</h1>
  <p class="sub">A free, confidential review to see whether you may have a claim — with no cost or obligation.</p>

  <h2>Three simple steps</h2>
  <ol class="steps">
    <li><strong>Tell us what happened</strong> — answer a few quick, secure questions about your situation.</li>
    <li><strong>We review your information</strong> — a case manager evaluates your potential claim against the criteria for that litigation.</li>
    <li><strong>Talk to someone</strong> — we follow up promptly with next steps.</li>
  </ol>

  <h2>What we look at</h2>
  <ul class="plain">
    <li>Whether your diagnosis or injury is one reviewed for that claim.</li>
    <li>Whether any required exposure is present.</li>
    <li>Whether the claim falls within the applicable filing window (statute of limitations).</li>
  </ul>

  <div class="strip">
    <span class="chip">✓ Free case review</span>
    <span class="chip">✓ No fees unless you win</span>
    <span class="chip">✓ Confidential &amp; secure</span>
  </div>

  ${relatedHtml("Browse claims by category", hubLinks)}
  ${relatedHtml("Reference", [{ name: "Mass tort glossary", url: `${baseUrl}/glossary` }])}
  ${disclaimerHtml()}
</div>`;

    setSeoHeaders(res, 3600);
    res.send(
      seoPageShell(
        {
          title: "How it works",
          description,
          canonical,
          jsonLd: [webPageJsonLd({ name: "How it works", description, url: canonical }), breadcrumbJsonLd(crumbs)],
        },
        baseUrl,
        body,
      ),
    );
  } catch (err) {
    logger.error({ err }, "Failed to render how-it-works");
    res.status(500).type("html").send("<h1>Something went wrong</h1>");
  }
});

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string,
  );
}

// ── GET /sitemap.xml — every live SEO page ───────────────────────────────────
router.get("/sitemap.xml", async (req, res) => {
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) return badRequest(res);
    const configs = await getAllFormConfigs();
    const manifest = buildSeoManifest(configs);

    const urls = manifest.pages
      .map((p) => {
        const loc = xmlEscape(`${baseUrl}${p.path}`);
        return `  <url><loc>${loc}</loc><changefreq>${p.changefreq}</changefreq><priority>${p.priority.toFixed(1)}</priority></url>`;
      })
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(xml);
  } catch (err) {
    logger.error({ err }, "Failed to render sitemap");
    res.status(500).type("text/plain").send("error");
  }
});

// ── GET /robots.txt — crawl policy ───────────────────────────────────────────
router.get("/robots.txt", (req, res) => {
  const baseUrl = resolveBaseUrl(req);
  const lines = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /intake/",
  ];
  if (baseUrl) lines.push(`Sitemap: ${baseUrl}/sitemap.xml`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(lines.join("\n") + "\n");
});

export default markPublic(router, "public-seo");
