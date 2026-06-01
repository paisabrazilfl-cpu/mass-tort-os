// Public SSR router for the 60-page-per-tort SEO network.
//
//   GET /c/:category                          — category hub.
//   GET /c/:category/:slug/:topic             — core authority supporting page,
//                                               :topic ∈ CORE_TOPICS (9).
//   GET /c/:category/:slug/state/:state       — state SEO page (20 per tort).
//   GET /c/:category/:slug/city/:city         — city SEO page (15 per tort).
//   GET /c/:category/:slug/blog/:blogSlug     — educational blog post (10).
//   GET /c/:category/:slug/resources/:slug    — resource / backlink page (5).
//   GET /glossary                             — evergreen domain glossary.
//   GET /how-it-works                         — evergreen process explainer.
//   GET /sitemap.xml                          — XML sitemap of every live page.
//   GET /robots.txt                           — crawl policy.
//
// PUBLIC (markPublic) — no JWT. Mounted BEFORE the SPA fallback in app.ts.
// Every fact rendered here is grounded in the DB-backed tort registry; no tort
// facts are invented (see seo-render.ts / seo-content.ts HARD RULES).

import { Router } from "express";
import { getAllFormConfigs, getFormConfig } from "../lib/form-config-service";
import type { FormConfigPublic } from "../lib/form-config-service";
import { markPublic } from "../lib/route-protection";
import { logger } from "../lib/logger";
import { htmlEscape, resolveBaseUrl, disclaimerHtml, brandingFromProfile } from "../lib/site-render";
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
  renderArticleBlocks,
  seoPageShell,
  setSeoHeaders,
  type BreadcrumbItem,
} from "../lib/seo-render";
import { buildSeoManifest, TORT_TOPICS, type TortTopic } from "../lib/seo-pages";
import {
  CORE_TOPICS,
  CORE_TOPIC_TITLES,
  isCoreArticleTopic,
  buildCoreArticle,
  SEO_STATES,
  SEO_CITIES,
  findState,
  findCity,
  BLOG_SLUGS,
  isBlogSlug,
  buildBlogArticle,
  RESOURCE_SLUGS,
  isResourceSlug,
  buildResourceArticle,
  buildStateArticle,
  buildCityArticle,
  slugify,
  type CoreTopic,
  type SeoArticle,
} from "../lib/seo-content";

const router = Router();

function isTortTopic(value: string): value is TortTopic {
  return (TORT_TOPICS as readonly string[]).includes(value);
}

function isCoreTopic(value: string): value is CoreTopic {
  return (CORE_TOPICS as readonly string[]).includes(value);
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

// ── per-tort URL + CTA helpers (shared by every article page) ─────────────────

interface TortUrls {
  hub: string;
  landing: string;
  eligibility: string;
  intake: string;
}

function tortUrls(baseUrl: string, category: string, slug: string): TortUrls {
  const safeCat = encodeURIComponent(category);
  const safeSlug = encodeURIComponent(slug);
  const landing = `${baseUrl}/c/${safeCat}/${safeSlug}`;
  return {
    hub: `${baseUrl}/c/${safeCat}`,
    landing,
    eligibility: `${landing}/eligibility`,
    intake: `${baseUrl}/intake/${safeSlug}`,
  };
}

function ctaHtml(href: string, text: string): string {
  return `<div style="margin:22px 0"><a class="cta" href="${htmlEscape(href)}">${htmlEscape(text)} →</a></div>`;
}

/** Standard internal links every article page carries (intake + eligibility + landing). */
function standardRelated(urls: TortUrls, label: string): BreadcrumbItem[] {
  return [
    { name: `${label}: Overview & eligibility check`, url: urls.landing },
    { name: `${label} claim eligibility`, url: urls.eligibility },
    { name: `Free ${label} case review`, url: urls.intake },
  ];
}

/**
 * Render a full article page (state / city / blog / resource / core-article)
 * with breadcrumbs, top/middle/bottom CTAs, related links, and JSON-LD. The
 * eligibility CTA is woven into the middle of the content; intake CTAs bookend
 * it, satisfying the "every page has top/middle/bottom CTA" linking rule.
 */
function renderTortArticle(opts: {
  baseUrl: string;
  config: FormConfigPublic;
  article: SeoArticle;
  canonical: string;
  crumbs: BreadcrumbItem[];
  related: BreadcrumbItem[];
  extraJsonLd?: object[];
}): string {
  const { baseUrl, config, article, canonical, crumbs, related, extraJsonLd = [] } = opts;
  const urls = tortUrls(baseUrl, config.category, config.id);

  const rendered = article.blocks.map((b) => renderArticleBlocks([b]));
  const midCta = ctaHtml(urls.eligibility, "See if you may qualify");
  let content = "";
  rendered.forEach((h, i) => {
    content += `${h}\n`;
    if (i === 0 && rendered.length > 1) content += `${midCta}\n`;
  });

  const body = `<div class="wrap">
  ${breadcrumbHtml(crumbs)}
  <span class="eyebrow">${htmlEscape(config.label)}</span>
  <h1>${htmlEscape(article.title)}</h1>
  ${ctaHtml(urls.intake, "Start your free case review")}
  ${content}
  ${ctaHtml(urls.intake, "Begin your free case review")}
  ${relatedHtml("Related pages", related)}
  ${disclaimerHtml()}
</div>`;

  const jsonLd: object[] = [
    webPageJsonLd({ name: article.title, description: article.description, url: canonical }),
    breadcrumbJsonLd(crumbs),
    ...extraJsonLd,
  ];

  return seoPageShell(
    { title: article.title, description: clampDescription(article.description), canonical, jsonLd },
    baseUrl,
    body,
    brandingFromProfile(config.site_profile, baseUrl),
  );
}

/** Load + validate an active tort by slug + category, or null. */
async function loadActiveTort(
  slug: string,
  category: string,
): Promise<FormConfigPublic | null> {
  const config = await getFormConfig(slug);
  if (!config || !config.active || config.category !== category) return null;
  return config;
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

// ── GET /c/:category/:slug/state/:state — state SEO page ──────────────────────
router.get("/c/:category/:slug/state/:state", async (req, res) => {
  const category = String(req.params.category);
  const slug = String(req.params.slug);
  const stateSlug = String(req.params.state);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) return badRequest(res);
    const canonical = `${baseUrl}/c/${encodeURIComponent(category)}/${encodeURIComponent(slug)}/state/${encodeURIComponent(stateSlug)}`;

    const state = findState(stateSlug);
    if (!state) return notFound(res, baseUrl, canonical);
    const config = await loadActiveTort(slug, category);
    if (!config) return notFound(res, baseUrl, canonical);

    const urls = tortUrls(baseUrl, category, slug);
    const article = buildStateArticle(state, config);
    const crumbs: BreadcrumbItem[] = [
      homeCrumb(baseUrl),
      { name: `${categoryLabel(config.category)} claims`, url: urls.hub },
      { name: config.label, url: urls.landing },
      { name: state.name, url: canonical },
    ];
    const otherStates = SEO_STATES.filter((s) => s.slug !== state.slug)
      .slice(0, 3)
      .map((s) => ({
        name: `${config.label} lawsuit in ${s.name}`,
        url: `${urls.landing}/state/${s.slug}`,
      }));
    const related = [...standardRelated(urls, config.label), ...otherStates];

    setSeoHeaders(res);
    res.send(renderTortArticle({ baseUrl, config, article, canonical, crumbs, related }));
  } catch (err) {
    logger.error({ err, category, slug, stateSlug }, "Failed to render state page");
    res.status(500).type("html").send("<h1>Something went wrong</h1>");
  }
});

// ── GET /c/:category/:slug/city/:city — city SEO page ─────────────────────────
router.get("/c/:category/:slug/city/:city", async (req, res) => {
  const category = String(req.params.category);
  const slug = String(req.params.slug);
  const citySlug = String(req.params.city);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) return badRequest(res);
    const canonical = `${baseUrl}/c/${encodeURIComponent(category)}/${encodeURIComponent(slug)}/city/${encodeURIComponent(citySlug)}`;

    const city = findCity(citySlug);
    if (!city) return notFound(res, baseUrl, canonical);
    const config = await loadActiveTort(slug, category);
    if (!config) return notFound(res, baseUrl, canonical);

    const urls = tortUrls(baseUrl, category, slug);
    const article = buildCityArticle(city, config);
    const crumbs: BreadcrumbItem[] = [
      homeCrumb(baseUrl),
      { name: `${categoryLabel(config.category)} claims`, url: urls.hub },
      { name: config.label, url: urls.landing },
      { name: `${city.name}, ${city.stateAbbr}`, url: canonical },
    ];
    const stateForCity = findState(require_slug(city.stateName));
    const cityExtras: BreadcrumbItem[] = [];
    if (stateForCity) {
      cityExtras.push({
        name: `${config.label} lawsuit in ${stateForCity.name}`,
        url: `${urls.landing}/state/${stateForCity.slug}`,
      });
    }
    cityExtras.push(
      ...SEO_CITIES.filter((c) => c.slug !== city.slug)
        .slice(0, 2)
        .map((c) => ({
          name: `${config.label} lawsuit in ${c.name}`,
          url: `${urls.landing}/city/${c.slug}`,
        })),
    );
    const related = [...standardRelated(urls, config.label), ...cityExtras];

    setSeoHeaders(res);
    res.send(renderTortArticle({ baseUrl, config, article, canonical, crumbs, related }));
  } catch (err) {
    logger.error({ err, category, slug, citySlug }, "Failed to render city page");
    res.status(500).type("html").send("<h1>Something went wrong</h1>");
  }
});

function require_slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── GET /c/:category/:slug/blog/:blogSlug — educational blog post ─────────────
router.get("/c/:category/:slug/blog/:blogSlug", async (req, res) => {
  const category = String(req.params.category);
  const slug = String(req.params.slug);
  const blogSlug = String(req.params.blogSlug);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) return badRequest(res);
    const canonical = `${baseUrl}/c/${encodeURIComponent(category)}/${encodeURIComponent(slug)}/blog/${encodeURIComponent(blogSlug)}`;

    if (!isBlogSlug(blogSlug)) return notFound(res, baseUrl, canonical);
    const config = await loadActiveTort(slug, category);
    if (!config) return notFound(res, baseUrl, canonical);

    const urls = tortUrls(baseUrl, category, slug);
    const article = buildBlogArticle(blogSlug, config);
    const crumbs: BreadcrumbItem[] = [
      homeCrumb(baseUrl),
      { name: `${categoryLabel(config.category)} claims`, url: urls.hub },
      { name: config.label, url: urls.landing },
      { name: article.title, url: canonical },
    ];
    const otherBlogs = BLOG_SLUGS.filter((b) => b !== blogSlug)
      .slice(0, 3)
      .map((b) => ({
        name: buildBlogArticle(b, config).title,
        url: `${urls.landing}/blog/${b}`,
      }));
    const related = [
      ...standardRelated(urls, config.label),
      ...otherBlogs,
      { name: `${config.label} resource center`, url: `${urls.landing}/resources/resource-center` },
    ];

    setSeoHeaders(res);
    res.send(renderTortArticle({ baseUrl, config, article, canonical, crumbs, related }));
  } catch (err) {
    logger.error({ err, category, slug, blogSlug }, "Failed to render blog post");
    res.status(500).type("html").send("<h1>Something went wrong</h1>");
  }
});

// ── GET /c/:category/:slug/resources/:resourceSlug — resource page ────────────
router.get("/c/:category/:slug/resources/:resourceSlug", async (req, res) => {
  const category = String(req.params.category);
  const slug = String(req.params.slug);
  const resourceSlug = String(req.params.resourceSlug);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) return badRequest(res);
    const canonical = `${baseUrl}/c/${encodeURIComponent(category)}/${encodeURIComponent(slug)}/resources/${encodeURIComponent(resourceSlug)}`;

    if (!isResourceSlug(resourceSlug)) return notFound(res, baseUrl, canonical);
    const config = await loadActiveTort(slug, category);
    if (!config) return notFound(res, baseUrl, canonical);

    const urls = tortUrls(baseUrl, category, slug);
    const article = buildResourceArticle(resourceSlug, config);
    const crumbs: BreadcrumbItem[] = [
      homeCrumb(baseUrl),
      { name: `${categoryLabel(config.category)} claims`, url: urls.hub },
      { name: config.label, url: urls.landing },
      { name: article.title, url: canonical },
    ];
    const otherResources = RESOURCE_SLUGS.filter((r) => r !== resourceSlug)
      .slice(0, 3)
      .map((r) => ({
        name: buildResourceArticle(r, config).title,
        url: `${urls.landing}/resources/${r}`,
      }));
    const related = [
      ...standardRelated(urls, config.label),
      ...otherResources,
      { name: `${config.label} FAQ`, url: `${urls.landing}/faq` },
    ];

    setSeoHeaders(res);
    res.send(renderTortArticle({ baseUrl, config, article, canonical, crumbs, related }));
  } catch (err) {
    logger.error({ err, category, slug, resourceSlug }, "Failed to render resource page");
    res.status(500).type("html").send("<h1>Something went wrong</h1>");
  }
});

// ── GET /c/:category/:slug/:topic — core authority supporting page ────────────
router.get("/c/:category/:slug/:topic", async (req, res) => {
  const category = String(req.params.category);
  const slug = String(req.params.slug);
  const topic = String(req.params.topic);
  try {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) return badRequest(res);
    const canonical = `${baseUrl}/c/${encodeURIComponent(category)}/${encodeURIComponent(slug)}/${encodeURIComponent(topic)}`;

    if (!isCoreTopic(topic)) return notFound(res, baseUrl, canonical);

    const config = await loadActiveTort(slug, category);
    if (!config) return notFound(res, baseUrl, canonical);

    const urls = tortUrls(baseUrl, config.category, config.id);
    const label = config.label;

    // Spoke links: landing + a few sibling core pages + hub.
    const siblingLinks: BreadcrumbItem[] = [
      ...standardRelated(urls, label),
      ...CORE_TOPICS.filter((t) => t !== topic && t !== "eligibility")
        .slice(0, 3)
        .map((t) => ({ name: `${label}: ${CORE_TOPIC_TITLES[t]}`, url: `${urls.landing}/${t}` })),
      { name: `${categoryLabel(config.category)} claims`, url: urls.hub },
    ];

    const crumbs: BreadcrumbItem[] = [
      homeCrumb(baseUrl),
      { name: `${categoryLabel(config.category)} claims`, url: urls.hub },
      { name: label, url: urls.landing },
      { name: CORE_TOPIC_TITLES[topic], url: canonical },
    ];

    // The six new core topics are article-driven; symptoms/diagnosis/faq keep
    // their bespoke grounded renderers.
    if (isCoreArticleTopic(topic)) {
      const article = buildCoreArticle(topic, config);
      setSeoHeaders(res);
      return res.send(
        renderTortArticle({ baseUrl, config, article, canonical, crumbs, related: siblingLinks }),
      );
    }

    // Legacy topics: symptoms / diagnosis / faq.
    const legacy = topic as TortTopic;
    const { title, description, content, faqItems } = renderTopic(legacy, config);

    const body = `<div class="wrap">
  ${breadcrumbHtml(crumbs)}
  <span class="eyebrow">${htmlEscape(label)}</span>
  <h1>${htmlEscape(title)}</h1>
  ${ctaHtml(urls.intake, "Start your free case review")}
  ${content}
  ${ctaHtml(urls.eligibility, "See if you may qualify")}
  ${ctaHtml(urls.intake, "Begin your free case review")}
  ${relatedHtml(`More on ${label} claims`, siblingLinks)}
  ${disclaimerHtml()}
</div>`;

    const jsonLd: object[] = [
      webPageJsonLd({ name: title, description, url: canonical }),
      breadcrumbJsonLd(crumbs),
    ];
    if (faqItems && faqItems.length) jsonLd.push(faqJsonLd(faqItems));

    setSeoHeaders(res);
    res.send(
      seoPageShell(
        { title, description, canonical, jsonLd },
        baseUrl,
        body,
        brandingFromProfile(config.site_profile, baseUrl),
      ),
    );
  } catch (err) {
    logger.error({ err, category, slug, topic }, "Failed to render supporting page");
    res.status(500).type("html").send("<h1>Something went wrong</h1>");
  }
});

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
