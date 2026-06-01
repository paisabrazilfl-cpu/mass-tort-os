// Canonical content library for the 60-page per-tort SEO/backlink network.
//
// This module is the single source of truth for the *non-landing* SEO surfaces
// every active tort gets: 9 core authority supporting pages, 20 state pages, 15
// city pages, 10 educational blog posts, and 5 resource/backlink pages. Together
// with the landing page that is 1 + 9 + 20 + 15 + 10 + 5 = 60 pages per tort.
//
// HARD RULES (mirrors seo-render.ts):
//   1. Every tort fact is pulled from the DB-backed registry row
//      (FormConfigPublic) — diagnoses from `valid_diagnoses`, the filing window
//      from `sol_months`, exposure from `required_exposure`. No tort facts are
//      invented here.
//   2. Compliance language only. We say "may qualify", "may be eligible",
//      "alleged", "potential", "results are not guaranteed". We NEVER promise a
//      settlement, compensation, approval, or outcome.
//
// Rendering (escaping, HTML shell) lives in seo-render.ts. This module only
// produces structured, plain-text content blocks; the renderer escapes them.

import type { FormConfigPublic } from "./form-config-service";
import { uniqueDiagnoses, statuteWindowText } from "./seo-render";

// ── structured content shapes (plain text — renderer escapes) ────────────────

export interface ContentBlock {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface SeoArticle {
  title: string;
  description: string;
  blocks: ContentBlock[];
}

// ── slug helpers ─────────────────────────────────────────────────────────────

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── A. core authority supporting pages (9; + landing = 10) ───────────────────
//
// symptoms / diagnosis / faq already existed; the other six are added here so
// the per-tort "core authority" set matches the Tier-1 spec.

export const CORE_TOPICS = [
  "eligibility",
  "symptoms",
  "diagnosis",
  "injury-overview",
  "evidence",
  "medical-records",
  "statute-of-limitations",
  "updates",
  "faq",
] as const;
export type CoreTopic = (typeof CORE_TOPICS)[number];

export const CORE_TOPIC_TITLES: Record<CoreTopic, string> = {
  eligibility: "Claim eligibility",
  symptoms: "Symptoms & eligibility",
  diagnosis: "Qualifying diagnoses & filing window",
  "injury-overview": "Injury overview",
  evidence: "Evidence needed",
  "medical-records": "Medical records guide",
  "statute-of-limitations": "Statute of limitations",
  updates: "Lawsuit updates",
  faq: "Frequently asked questions",
};

// The three legacy topics keep their dedicated renderers in public-seo.ts; the
// six below are rendered from the article builder in this module.
export const CORE_ARTICLE_TOPICS = [
  "eligibility",
  "injury-overview",
  "evidence",
  "medical-records",
  "statute-of-limitations",
  "updates",
] as const satisfies readonly CoreTopic[];
export type CoreArticleTopic = (typeof CORE_ARTICLE_TOPICS)[number];

export function isCoreArticleTopic(v: string): v is CoreArticleTopic {
  return (CORE_ARTICLE_TOPICS as readonly string[]).includes(v);
}

// ── B. state pages (20) ──────────────────────────────────────────────────────

export interface SeoState {
  name: string;
  abbr: string;
  slug: string;
}

export const SEO_STATES: readonly SeoState[] = Object.freeze(
  [
    ["Florida", "FL"],
    ["Texas", "TX"],
    ["California", "CA"],
    ["New York", "NY"],
    ["Georgia", "GA"],
    ["Illinois", "IL"],
    ["Pennsylvania", "PA"],
    ["Ohio", "OH"],
    ["Michigan", "MI"],
    ["North Carolina", "NC"],
    ["South Carolina", "SC"],
    ["Arizona", "AZ"],
    ["Nevada", "NV"],
    ["Tennessee", "TN"],
    ["Alabama", "AL"],
    ["Louisiana", "LA"],
    ["Missouri", "MO"],
    ["New Jersey", "NJ"],
    ["Massachusetts", "MA"],
    ["Washington", "WA"],
  ].map(([name, abbr]) => ({ name, abbr, slug: slugify(name) })),
);

export function findState(slug: string): SeoState | undefined {
  return SEO_STATES.find((s) => s.slug === slug);
}

// ── C. city pages (15; Florida-focused per spec default) ─────────────────────

export interface SeoCity {
  name: string;
  stateName: string;
  stateAbbr: string;
  slug: string;
}

export const SEO_CITIES: readonly SeoCity[] = Object.freeze(
  [
    "Miami",
    "Fort Lauderdale",
    "Tampa",
    "Orlando",
    "Jacksonville",
    "West Palm Beach",
    "Naples",
    "Sarasota",
    "Tallahassee",
    "Pensacola",
    "Gainesville",
    "Cape Coral",
    "Lakeland",
    "Port St. Lucie",
    "Hollywood",
  ].map((name) => ({
    name,
    stateName: "Florida",
    stateAbbr: "FL",
    slug: slugify(name),
  })),
);

export function findCity(slug: string): SeoCity | undefined {
  return SEO_CITIES.find((c) => c.slug === slug);
}

// ── D. educational blog posts (10) ───────────────────────────────────────────

export const BLOG_SLUGS = [
  "what-evidence-helps",
  "understanding-the-injury",
  "how-long-review-takes",
  "family-claims-after-death",
  "documents-you-need",
  "how-medical-records-help",
  "after-submitting-intake",
  "common-reasons-claims-not-accepted",
  "settlement-vs-claim-review",
  "questions-before-signing",
] as const;
export type BlogSlug = (typeof BLOG_SLUGS)[number];

export function isBlogSlug(v: string): v is BlogSlug {
  return (BLOG_SLUGS as readonly string[]).includes(v);
}

// ── E. resource / backlink pages (5) ─────────────────────────────────────────

export const RESOURCE_SLUGS = [
  "resource-center",
  "research-and-litigation-timeline",
  "legal-update-archive",
  "product-liability-claim-guide",
  "documentation-checklist",
] as const;
export type ResourceSlug = (typeof RESOURCE_SLUGS)[number];

export function isResourceSlug(v: string): v is ResourceSlug {
  return (RESOURCE_SLUGS as readonly string[]).includes(v);
}

// ── grounded text fragments shared across builders ───────────────────────────

function diagnosisPhrase(config: FormConfigPublic): string {
  const dx = uniqueDiagnoses(config.valid_diagnoses);
  if (!dx.length) return "a qualifying medical condition";
  if (dx.length === 1) return dx[0];
  if (dx.length === 2) return `${dx[0]} or ${dx[1]}`;
  return `${dx.slice(0, 3).join(", ")}, or another qualifying condition`;
}

function deadlineSentence(config: FormConfigPublic, where: string): string {
  const statute = statuteWindowText(config.sol_months);
  if (statute) {
    return (
      `Filing deadlines (statutes of limitations) ${where} can be as short as ` +
      `${statute} from diagnosis or from when an injury was discovered, and they ` +
      `vary by state. Acting promptly helps protect your potential rights.`
    );
  }
  return (
    `Filing deadlines (statutes of limitations) ${where} vary by state and by ` +
    `when an injury was discovered. Acting promptly helps protect your potential rights.`
  );
}

const RESULTS_DISCLAIMER =
  "Each case is reviewed individually and results are not guaranteed. Submitting a " +
  "form does not create an attorney-client relationship.";

// ── builders: core authority supporting articles ─────────────────────────────

export function buildCoreArticle(
  topic: CoreArticleTopic,
  config: FormConfigPublic,
): SeoArticle {
  const label = config.label;
  const dxPhrase = diagnosisPhrase(config);
  const dx = uniqueDiagnoses(config.valid_diagnoses);

  switch (topic) {
    case "eligibility":
      return {
        title: `${label} claim eligibility`,
        description: `See who may qualify for a ${label} claim review — the factors we evaluate and how to start a free, confidential eligibility check.`,
        blocks: [
          {
            paragraphs: [
              `You may be eligible for a free ${label} claim review if your situation matches the factors below. Eligibility is confirmed individually during a no-obligation review.`,
            ],
          },
          {
            heading: "You may qualify if:",
            bullets: [
              config.required_exposure
                ? `You had documented exposure related to ${label}.`
                : `You were affected in a way reviewed for ${label} claims.`,
              `You were later diagnosed with ${dxPhrase}.`,
              `Your diagnosis occurred after the alleged exposure or use.`,
              `You have medical records or can request them.`,
              `You have not already resolved this same claim.`,
              `You are not currently represented for this same claim.`,
            ],
          },
          {
            heading: "What happens next",
            paragraphs: [
              `If your situation may fit, your information is reviewed and, if appropriate, may be referred for a legal evaluation. ${RESULTS_DISCLAIMER}`,
            ],
          },
        ],
      };

    case "injury-overview":
      return {
        title: `${label} injury overview`,
        description: `An overview of the injuries reviewed in ${label} claims and why timing relative to exposure may matter.`,
        blocks: [
          {
            paragraphs: [
              `${label} claims generally involve allegations that ${label} may be associated with serious health conditions. The conditions reviewed for these claims are listed below, and each potential claim is evaluated on its own facts.`,
            ],
          },
          dx.length
            ? { heading: "Conditions reviewed", bullets: dx }
            : {
                heading: "Conditions reviewed",
                paragraphs: [
                  `Qualifying conditions are confirmed during a short, free review of your situation.`,
                ],
              },
          {
            heading: "Why timing matters",
            paragraphs: [
              `When a diagnosis occurred after the alleged exposure or use, that timing may support a potential claim. ${deadlineSentence(config, "for these claims")}`,
            ],
          },
        ],
      };

    case "evidence":
      return {
        title: `Evidence needed for a ${label} claim`,
        description: `The documents and details that may help support a ${label} claim — and how to gather them.`,
        blocks: [
          {
            paragraphs: [
              `Strong ${label} claims are supported by documentation. You do not need to have everything ready to start — we can help you identify and request what may be missing.`,
            ],
          },
          {
            heading: "Helpful documents and details",
            bullets: [
              config.required_exposure
                ? `Records establishing exposure or use related to ${label}.`
                : `Records describing how you were affected.`,
              `Medical records confirming a diagnosis of ${dxPhrase}.`,
              `Dates of diagnosis and of the alleged exposure or use.`,
              `Treating doctor, hospital, or clinic names.`,
              `Any prior correspondence about this potential claim.`,
            ],
          },
          {
            heading: "Don't have records yet?",
            paragraphs: [
              `That is common. Many people can request their own medical records, and our review can guide you on how to obtain them. ${RESULTS_DISCLAIMER}`,
            ],
          },
        ],
      };

    case "medical-records":
      return {
        title: `Medical records guide for ${label} lawsuits`,
        description: `How medical records support a ${label} claim review and practical steps to request yours.`,
        blocks: [
          {
            paragraphs: [
              `Medical records are often the most important evidence in a ${label} claim because they can document a diagnosis of ${dxPhrase} and its timing.`,
            ],
          },
          {
            heading: "How to request your records",
            bullets: [
              `Contact the hospital or clinic's medical records (HIM) department.`,
              `Ask for a complete copy, including imaging and pathology reports.`,
              `Provide identification and complete any authorization form.`,
              `Keep a copy of every request you submit.`,
            ],
          },
          {
            heading: "We can help",
            paragraphs: [
              `If you are unable to obtain records on your own, a medical-record retrieval option may be available as part of the review process. ${RESULTS_DISCLAIMER}`,
            ],
          },
        ],
      };

    case "statute-of-limitations":
      return {
        title: `${label} statute of limitations overview`,
        description: `How filing deadlines (statutes of limitations) may apply to ${label} claims, in careful, general terms.`,
        blocks: [
          {
            paragraphs: [
              `A statute of limitations is the legal deadline for filing a claim. ${deadlineSentence(config, "for these claims")}`,
            ],
          },
          {
            heading: "Why deadlines vary",
            bullets: [
              `Each state sets its own deadline, which may differ for product, injury, or wrongful-death claims.`,
              `A "discovery rule" may start the clock when an injury or its cause was discovered.`,
              `Deadlines can be shorter than people expect, so a prompt review is important.`,
            ],
          },
          {
            heading: "Important",
            paragraphs: [
              `This page is general information, not legal advice about your specific deadline. A free review can help clarify which timeframe may apply to your situation. ${RESULTS_DISCLAIMER}`,
            ],
          },
        ],
      };

    case "updates":
      return {
        title: `${label} lawsuit updates`,
        description: `General information about how ${label} litigation may progress and how to stay informed.`,
        blocks: [
          {
            paragraphs: [
              `${label} litigation, like other mass torts, may move through stages over time. The notes below describe how such cases generally proceed; they are not predictions about any specific claim.`,
            ],
          },
          {
            heading: "How mass tort cases generally progress",
            bullets: [
              `Individual claims may be reviewed and filed as eligibility is confirmed.`,
              `Similar federal cases may be consolidated for pretrial proceedings (an MDL).`,
              `Representative "bellwether" cases may help the parties gauge how claims could be evaluated.`,
              `Any resolution depends on the individual facts of each case.`,
            ],
          },
          {
            heading: "Stay informed",
            paragraphs: [
              `The most reliable way to understand where your potential claim stands is a free, confidential review. ${RESULTS_DISCLAIMER}`,
            ],
          },
        ],
      };
  }
}

// ── builders: state + city pages ─────────────────────────────────────────────

export function buildStateArticle(
  state: SeoState,
  config: FormConfigPublic,
): SeoArticle {
  const label = config.label;
  const dxPhrase = diagnosisPhrase(config);
  return {
    title: `${label} lawsuit in ${state.name}`,
    description: `${state.name} residents who were diagnosed with ${dxPhrase} after ${label} may be eligible for a free claim review. Learn how ${state.name} deadlines may apply.`,
    blocks: [
      {
        paragraphs: [
          `If you live in ${state.name} and were diagnosed with ${dxPhrase} after ${label}, you may be eligible for a free, confidential claim review. ${state.name} (${state.abbr}) residents are reviewed individually, the same as everywhere else we serve.`,
        ],
      },
      {
        heading: `How the review works for ${state.name} residents`,
        paragraphs: [
          `Your exposure and diagnosis information is reviewed against the criteria for ${label} claims. If your situation may fit, supporting medical records may be requested, and your claim may be referred for legal evaluation.`,
        ],
      },
      {
        heading: `${state.name} filing deadlines`,
        paragraphs: [deadlineSentence(config, `in ${state.name}`)],
      },
      {
        heading: "Start a free review",
        paragraphs: [
          `A ${state.name} ${label} claim review is free and confidential, with no upfront legal fees. ${RESULTS_DISCLAIMER}`,
        ],
      },
    ],
  };
}

export function buildCityArticle(
  city: SeoCity,
  config: FormConfigPublic,
): SeoArticle {
  const label = config.label;
  const dxPhrase = diagnosisPhrase(config);
  return {
    title: `${label} lawsuit in ${city.name}, ${city.stateAbbr}`,
    description: `${city.name}, ${city.stateName} residents diagnosed with ${dxPhrase} after ${label} may qualify for a free claim review. No upfront legal fees.`,
    blocks: [
      {
        paragraphs: [
          `Residents of ${city.name}, ${city.stateName} who were diagnosed with ${dxPhrase} after ${label} may be eligible for a free claim review. Every potential claim is evaluated on its own facts.`,
        ],
      },
      {
        heading: `Free, confidential review for ${city.name}`,
        paragraphs: [
          `There is no cost to find out whether you may qualify, and no upfront legal fees. Your information is reviewed, supporting records may be requested, and eligible claims may be referred for legal evaluation.`,
        ],
      },
      {
        heading: "Deadlines may apply",
        paragraphs: [deadlineSentence(config, `for ${city.stateName} residents`)],
      },
      {
        heading: "Next step",
        paragraphs: [
          `Start your free ${label} eligibility check online. ${RESULTS_DISCLAIMER}`,
        ],
      },
    ],
  };
}

// ── builders: blog posts ─────────────────────────────────────────────────────

export function buildBlogArticle(
  slug: BlogSlug,
  config: FormConfigPublic,
): SeoArticle {
  const label = config.label;
  const dxPhrase = diagnosisPhrase(config);

  switch (slug) {
    case "what-evidence-helps":
      return {
        title: `What evidence helps a ${label} lawsuit?`,
        description: `The kinds of records and details that may strengthen a ${label} claim, in plain English.`,
        blocks: [
          {
            paragraphs: [
              `Documentation is what turns a possible ${label} claim into one that can be evaluated. The strongest claims connect a diagnosis of ${dxPhrase} to the alleged exposure or use, and show when each occurred.`,
            ],
          },
          {
            heading: "Evidence that may help",
            bullets: [
              `Medical records confirming the diagnosis.`,
              `Imaging, pathology, or specialist reports.`,
              config.required_exposure
                ? `Records establishing exposure or use.`
                : `Records describing how you were affected.`,
              `A timeline of diagnosis and exposure or use.`,
            ],
          },
          {
            paragraphs: [RESULTS_DISCLAIMER],
          },
        ],
      };

    case "understanding-the-injury":
      return {
        title: `Understanding the injuries reviewed in ${label} claims`,
        description: `A plain-language look at the conditions reviewed in ${label} claims and why they may matter.`,
        blocks: [
          {
            paragraphs: [
              `${label} claims involve allegations that ${label} may be associated with serious medical conditions. Understanding which conditions are reviewed can help you decide whether a free review makes sense for you.`,
            ],
          },
          {
            heading: "Conditions commonly reviewed",
            bullets: uniqueDiagnoses(config.valid_diagnoses).length
              ? uniqueDiagnoses(config.valid_diagnoses)
              : [`Confirmed during a free review of your situation.`],
          },
          { paragraphs: [RESULTS_DISCLAIMER] },
        ],
      };

    case "how-long-review-takes":
      return {
        title: `How long does a ${label} claim review take?`,
        description: `What to expect on timing when you submit a ${label} claim review, in careful general terms.`,
        blocks: [
          {
            paragraphs: [
              `An initial ${label} eligibility check is quick — often just a few minutes to complete online. The review of your information afterward depends on your situation and how quickly supporting records can be gathered.`,
            ],
          },
          {
            heading: "What can affect timing",
            bullets: [
              `How complete your contact and diagnosis information is.`,
              `Whether medical records are already available or must be requested.`,
              `The complexity of your individual situation.`,
            ],
          },
          { paragraphs: [RESULTS_DISCLAIMER] },
        ],
      };

    case "family-claims-after-death":
      return {
        title: `Can family members file a ${label} claim after a loved one's death?`,
        description: `How family members or estate representatives may pursue a ${label} claim, in general terms.`,
        blocks: [
          {
            paragraphs: [
              `In many situations, a spouse, child, or estate representative may be able to pursue a ${label} claim on behalf of a loved one who has passed away. These are often called wrongful-death or survival claims, and the rules vary by state.`,
            ],
          },
          {
            heading: "Information that may help",
            bullets: [
              `Your relationship to the injured person.`,
              `Whether an estate or personal representative has been appointed.`,
              `Medical records confirming the diagnosis of ${dxPhrase}.`,
            ],
          },
          { paragraphs: [RESULTS_DISCLAIMER] },
        ],
      };

    case "documents-you-need":
      return {
        title: `What documents do you need for a ${label} claim?`,
        description: `A simple checklist of documents that may help when you start a ${label} claim review.`,
        blocks: [
          {
            paragraphs: [
              `You do not need every document to begin a ${label} review, but gathering what you can may speed things up.`,
            ],
          },
          {
            heading: "A simple checklist",
            bullets: [
              `Photo identification.`,
              `Medical records showing a diagnosis of ${dxPhrase}.`,
              config.required_exposure
                ? `Anything documenting exposure or use.`
                : `Anything documenting how you were affected.`,
              `Names of treating doctors and facilities.`,
              `Approximate dates of diagnosis and exposure or use.`,
            ],
          },
          { paragraphs: [RESULTS_DISCLAIMER] },
        ],
      };

    case "how-medical-records-help":
      return {
        title: `How medical records support a ${label} lawsuit`,
        description: `Why medical records matter in a ${label} claim and how to obtain yours.`,
        blocks: [
          {
            paragraphs: [
              `Medical records can establish two things that matter in a ${label} claim: that a qualifying condition such as ${dxPhrase} was diagnosed, and when. That timing can be central to a potential claim.`,
            ],
          },
          {
            heading: "Getting your records",
            bullets: [
              `Request a complete copy from each treating facility.`,
              `Include imaging and pathology where applicable.`,
              `Keep copies of everything you request.`,
            ],
          },
          { paragraphs: [RESULTS_DISCLAIMER] },
        ],
      };

    case "after-submitting-intake":
      return {
        title: `What happens after submitting a ${label} intake form?`,
        description: `A step-by-step look at what to expect after you complete a ${label} intake form.`,
        blocks: [
          {
            paragraphs: [
              `After you submit a ${label} intake form, your information enters a review process. Here is what generally happens next.`,
            ],
          },
          {
            heading: "After you submit",
            bullets: [
              `You receive a confirmation that your information was received.`,
              `Your exposure and diagnosis information is reviewed.`,
              `Supporting medical records may be requested.`,
              `If eligible, your claim may be referred for legal evaluation.`,
            ],
          },
          { paragraphs: [RESULTS_DISCLAIMER] },
        ],
      };

    case "common-reasons-claims-not-accepted":
      return {
        title: `Common reasons ${label} claims are not accepted`,
        description: `Understanding why some ${label} claims may not move forward can help you prepare.`,
        blocks: [
          {
            paragraphs: [
              `Not every ${label} submission becomes an accepted claim. Knowing the common reasons can help set expectations — and sometimes can be addressed with more information.`,
            ],
          },
          {
            heading: "Reasons a claim may not move forward",
            bullets: [
              `No qualifying diagnosis such as ${dxPhrase} is documented.`,
              `The timing between exposure or use and diagnosis does not fit.`,
              `The applicable filing deadline appears to have passed.`,
              `The same claim is already resolved or represented elsewhere.`,
            ],
          },
          { paragraphs: [RESULTS_DISCLAIMER] },
        ],
      };

    case "settlement-vs-claim-review":
      return {
        title: `The difference between a settlement and a ${label} claim review`,
        description: `What "claim review" means versus a "settlement" in ${label} litigation, explained simply.`,
        blocks: [
          {
            paragraphs: [
              `These terms are easy to confuse. A claim review is the free, no-obligation evaluation of whether your situation may fit the criteria for a ${label} claim. A settlement is a possible later resolution of a claim by agreement — and it is never guaranteed.`,
            ],
          },
          {
            heading: "Key differences",
            bullets: [
              `A review is free and creates no obligation.`,
              `A review does not promise any payment or outcome.`,
              `Any settlement depends entirely on the individual facts of a case.`,
            ],
          },
          { paragraphs: [RESULTS_DISCLAIMER] },
        ],
      };

    case "questions-before-signing":
      return {
        title: `What to ask before signing with a law firm`,
        description: `Smart questions to ask before signing a representation agreement for a ${label} claim.`,
        blocks: [
          {
            paragraphs: [
              `Before signing with any law firm about a ${label} claim, it is reasonable to ask questions so you understand the arrangement.`,
            ],
          },
          {
            heading: "Questions worth asking",
            bullets: [
              `How are fees handled, and are there any costs to me?`,
              `Who will actually handle my case?`,
              `How and how often will I be updated?`,
              `What are the realistic next steps and timeframes?`,
            ],
          },
          {
            paragraphs: [
              `A free review can answer many of these questions before any commitment. ${RESULTS_DISCLAIMER}`,
            ],
          },
        ],
      };
  }
}

// ── builders: resource / backlink pages ──────────────────────────────────────

export function buildResourceArticle(
  slug: ResourceSlug,
  config: FormConfigPublic,
): SeoArticle {
  const label = config.label;
  const dxPhrase = diagnosisPhrase(config);

  switch (slug) {
    case "resource-center":
      return {
        title: `${label} lawsuit resource center`,
        description: `A central hub of free, plain-language resources about ${label} claims — eligibility, evidence, deadlines, and more.`,
        blocks: [
          {
            paragraphs: [
              `Welcome to the ${label} resource center — a free, plain-language hub to help you understand whether you may have a claim and what to do next.`,
            ],
          },
          {
            heading: "What you'll find here",
            bullets: [
              `Who may qualify and how eligibility is reviewed.`,
              `What evidence and medical records may help.`,
              `How filing deadlines may apply.`,
              `What to expect after you submit an intake form.`,
            ],
          },
          { paragraphs: [RESULTS_DISCLAIMER] },
        ],
      };

    case "research-and-litigation-timeline":
      return {
        title: `${label} research & litigation timeline`,
        description: `A general overview of how ${label} research and litigation may develop over time.`,
        blocks: [
          {
            paragraphs: [
              `Mass tort litigation such as ${label} generally develops in phases. This timeline describes how such matters typically progress in general terms — it is not a statement about any specific claim or outcome.`,
            ],
          },
          {
            heading: "Typical phases",
            bullets: [
              `Emerging research and reports raise questions about a potential association.`,
              `Individual claims are reviewed and filed as eligibility is confirmed.`,
              `Similar federal cases may be consolidated for pretrial proceedings.`,
              `Representative cases may help gauge how claims could be evaluated.`,
            ],
          },
          { paragraphs: [RESULTS_DISCLAIMER] },
        ],
      };

    case "legal-update-archive":
      return {
        title: `${label} legal update archive`,
        description: `Where to understand general developments in ${label} litigation and how they may relate to your potential claim.`,
        blocks: [
          {
            paragraphs: [
              `This archive explains, in general terms, the kinds of developments that can occur in ${label} litigation. For information specific to your situation, a free review is the most reliable source.`,
            ],
          },
          {
            heading: "Kinds of developments to watch",
            bullets: [
              `Consolidation of similar cases for pretrial proceedings.`,
              `Scheduling of representative ("bellwether") cases.`,
              `Court rulings that may affect how claims are handled.`,
            ],
          },
          { paragraphs: [RESULTS_DISCLAIMER] },
        ],
      };

    case "product-liability-claim-guide":
      return {
        title: `Product liability claim guide`,
        description: `A plain-language guide to product liability concepts that may apply to ${label} claims.`,
        blocks: [
          {
            paragraphs: [
              `Many ${label} claims involve product liability allegations. This guide explains the common concepts in plain language so you can better understand a potential claim.`,
            ],
          },
          {
            heading: "Common allegations",
            bullets: [
              `Failure to warn about a potential risk.`,
              `Defective design or manufacturing.`,
              `Negligence in testing or marketing.`,
            ],
          },
          {
            paragraphs: [
              `Whether any of these may apply depends on the facts of each case. ${RESULTS_DISCLAIMER}`,
            ],
          },
        ],
      };

    case "documentation-checklist":
      return {
        title: `Medical documentation checklist for ${label} claims`,
        description: `A practical checklist of medical documentation that may support a ${label} claim.`,
        blocks: [
          {
            paragraphs: [
              `Use this checklist to gather documentation that may support a ${label} claim. You can start a review before you have everything.`,
            ],
          },
          {
            heading: "Documentation checklist",
            bullets: [
              `Records confirming a diagnosis of ${dxPhrase}.`,
              `Imaging and pathology reports, where applicable.`,
              `Dates of diagnosis and of exposure or use.`,
              `Names of treating doctors and facilities.`,
              config.required_exposure
                ? `Anything documenting exposure or use.`
                : `Anything documenting how you were affected.`,
            ],
          },
          { paragraphs: [RESULTS_DISCLAIMER] },
        ],
      };
  }
}
