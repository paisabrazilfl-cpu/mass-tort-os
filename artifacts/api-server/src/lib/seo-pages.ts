// SEO page manifest — the single source of truth for every public SEO URL.
//
// Both the sitemap route (GET /sitemap.xml) and the admin "rebuild all SEO
// pages" action (POST /api/sites/seo/rebuild-all) consume this, so the set of
// pages they each see can never drift. The manifest is a pure function of the
// active tort registry rows, which makes the rebuild action idempotent by
// construction: same registry in → same URL set out, with zero duplicates.

import type { FormConfigPublic } from "./form-config-service";
import { CATEGORY_LABELS } from "./seo-render";

export type SeoPageKind =
  | "landing"
  | "symptoms"
  | "diagnosis"
  | "faq"
  | "category-hub"
  | "glossary"
  | "how-it-works";

export interface SeoPage {
  /** Root-relative path (no host). */
  path: string;
  kind: SeoPageKind;
  /** sitemap <changefreq>. */
  changefreq: "daily" | "weekly" | "monthly";
  /** sitemap <priority>, 0..1. */
  priority: number;
}

/** The three supporting topical pages every live tort gets. */
export const TORT_TOPICS = ["symptoms", "diagnosis", "faq"] as const;
export type TortTopic = (typeof TORT_TOPICS)[number];

export const TOPIC_KIND: Record<TortTopic, SeoPageKind> = {
  symptoms: "symptoms",
  diagnosis: "diagnosis",
  faq: "faq",
};

function enc(s: string): string {
  return encodeURIComponent(s);
}

export interface SeoManifest {
  pages: SeoPage[];
  counts: {
    total: number;
    landing: number;
    supporting: number;
    hubs: number;
    static: number;
    torts: number;
    categories: number;
  };
  /** Any path that appeared more than once (should always be empty). */
  duplicates: string[];
}

/**
 * Build the full SEO page manifest from the form-config rows. Only ACTIVE rows
 * (and rows that resolve to a real canonical category) contribute pages —
 * soft-deleted torts drop out instantly, exactly like the live routes.
 */
export function buildSeoManifest(configs: FormConfigPublic[]): SeoManifest {
  const pages: SeoPage[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  function add(page: SeoPage): void {
    if (seen.has(page.path)) {
      duplicates.push(page.path);
      return;
    }
    seen.add(page.path);
    pages.push(page);
  }

  // Static evergreen pages.
  add({ path: "/how-it-works", kind: "how-it-works", changefreq: "monthly", priority: 0.6 });
  add({ path: "/glossary", kind: "glossary", changefreq: "monthly", priority: 0.5 });

  const active = configs.filter(
    (c) => c.active && Boolean(CATEGORY_LABELS[c.category]),
  );

  // Category hubs — one per canonical category that has at least one live tort.
  const categoriesWithTorts = new Set(active.map((c) => c.category));
  for (const category of Object.keys(CATEGORY_LABELS)) {
    if (!categoriesWithTorts.has(category)) continue;
    add({
      path: `/c/${enc(category)}`,
      kind: "category-hub",
      changefreq: "weekly",
      priority: 0.7,
    });
  }

  // Per-tort landing + supporting topical pages.
  for (const c of active) {
    const base = `/c/${enc(c.category)}/${enc(c.id)}`;
    add({ path: base, kind: "landing", changefreq: "weekly", priority: 0.8 });
    for (const topic of TORT_TOPICS) {
      add({
        path: `${base}/${topic}`,
        kind: TOPIC_KIND[topic],
        changefreq: "monthly",
        priority: 0.6,
      });
    }
  }

  const landing = pages.filter((p) => p.kind === "landing").length;
  const hubs = pages.filter((p) => p.kind === "category-hub").length;
  const staticCount = pages.filter(
    (p) => p.kind === "glossary" || p.kind === "how-it-works",
  ).length;
  const supporting = pages.filter(
    (p) => p.kind === "symptoms" || p.kind === "diagnosis" || p.kind === "faq",
  ).length;

  return {
    pages,
    counts: {
      total: pages.length,
      landing,
      supporting,
      hubs,
      static: staticCount,
      torts: active.length,
      categories: categoriesWithTorts.size,
    },
    duplicates,
  };
}
