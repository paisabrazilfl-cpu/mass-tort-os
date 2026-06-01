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

import { Router } from "express";
import { getFormConfig } from "../lib/form-config-service";
import { markPublic } from "../lib/route-protection";
import { logger } from "../lib/logger";
import {
  NOT_A_LAW_FIRM_DISCLAIMER,
  INTAKE_HEADER_EYEBROW,
  INTAKE_HEADER_TRUST,
  htmlEscape,
  pageShell,
  disclaimerHtml,
  setPublicHeaders,
  eligibilityChecklistItems,
  resolveBaseUrl,
  brandingFromProfile,
} from "../lib/site-render";
import {
  categoryLabel,
  clampDescription,
  uniqueDiagnoses,
  breadcrumbHtml,
  breadcrumbJsonLd,
  webPageJsonLd,
  relatedHtml,
  seoPageShell,
  setSeoHeaders,
  type BreadcrumbItem,
} from "../lib/seo-render";

const router = Router();

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
    res.send(
      pageShell(
        `${headline} — Intake`,
        body,
        brandingFromProfile(config.site_profile, baseUrl),
      ),
    );
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
      setSeoHeaders(res, 0);
      res.send(
        seoPageShell(
          {
            title: "Page not found",
            description: "This campaign is not available.",
            canonical: `${baseUrl}/c/${encodeURIComponent(category)}/${encodeURIComponent(slug)}`,
            robots: "noindex,follow",
          },
          baseUrl,
          `<div class="wrap"><h1>Page not found</h1><p class="sub">This campaign is not available.</p>${disclaimerHtml()}</div>`,
        ),
      );
      return;
    }

    const cfg = config.web_form_config;
    const safeSlug = encodeURIComponent(slug);
    const safeCat = encodeURIComponent(config.category);
    const canonical = `${baseUrl}/c/${safeCat}/${safeSlug}`;
    const intakeUrl = `${baseUrl}/intake/${safeSlug}`;
    const headline = cfg?.intro_headline || config.label;
    const subhead = cfg?.intro_subhead || `See if you may qualify for a ${config.label} claim.`;
    const checklist = cfg ? eligibilityChecklistItems(cfg) : [];
    const dx = uniqueDiagnoses(config.valid_diagnoses);

    const checklistHtml = checklist.length > 0
      ? `<h2>Do any of these apply to you?</h2>
  <ul class="checklist">${checklist.map(i => `<li>${htmlEscape(i)}</li>`).join("")}</ul>`
      : "";

    const ctaDisabled = !(config.active && cfg?.enabled);
    const ctaHtml = ctaDisabled
      ? `<span class="chip">Intake currently closed</span>`
      : `<a class="cta" href="${htmlEscape(intakeUrl)}">Check if you qualify →</a>`;

    // Hub-and-spoke: link the landing page to its three supporting pages and
    // back up to the category hub.
    const spokes: BreadcrumbItem[] = [
      { name: `${config.label}: Symptoms & eligibility`, url: `${canonical}/symptoms` },
      { name: `${config.label}: Qualifying diagnoses & filing window`, url: `${canonical}/diagnosis` },
      { name: `${config.label}: Frequently asked questions`, url: `${canonical}/faq` },
      { name: `${categoryLabel(config.category)} claims`, url: `${baseUrl}/c/${safeCat}` },
    ];

    const crumbs: BreadcrumbItem[] = [
      { name: "Home", url: `${baseUrl}/how-it-works` },
      { name: `${categoryLabel(config.category)} claims`, url: `${baseUrl}/c/${safeCat}` },
      { name: config.label, url: canonical },
    ];

    const description = clampDescription(
      `${config.label} claim review${dx.length ? `: qualifying conditions include ${dx.slice(0, 3).join(", ")}.` : "."} Free, confidential eligibility check — no fees unless you win.`,
    );

    const branding = brandingFromProfile(config.site_profile, baseUrl);
    const heroHtml = branding?.heroUrl
      ? `<img class="hero" src="${htmlEscape(branding.heroUrl)}" alt="${htmlEscape(config.label)}" loading="eager" />`
      : "";

    const body = `<div class="wrap">
  ${breadcrumbHtml(crumbs)}
  ${heroHtml}
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
    <li><strong>Talk to someone</strong> — we follow up promptly with next steps.</li>
  </ol>

  ${relatedHtml(`Learn more about ${config.label} claims`, spokes)}

  ${disclaimerHtml()}
</div>
${ctaDisabled ? "" : `<div class="sticky"><a class="cta" href="${htmlEscape(intakeUrl)}">Check if you qualify →</a></div>`}`;

    setSeoHeaders(res);
    res.send(
      seoPageShell(
        {
          title: headline,
          description,
          canonical,
          ogType: "website",
          jsonLd: [
            webPageJsonLd({ name: `${config.label} claim review`, description, url: canonical }),
            breadcrumbJsonLd(crumbs),
          ],
        },
        baseUrl,
        body,
        branding,
      ),
    );
  } catch (err) {
    logger.error({ err, category, slug }, "Failed to render landing page");
    res.status(500).type("html").send(pageShell("Error", `<div class="wrap"><h1>Something went wrong</h1></div>`));
  }
});

export default markPublic(router, "public-sites");
