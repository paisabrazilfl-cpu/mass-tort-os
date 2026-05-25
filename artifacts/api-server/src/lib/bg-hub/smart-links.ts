/**
 * Smart-link generators for bg-hub lanes that can't be fully automated
 * but CAN be made one-click for the operator.
 *
 * Contract: every function here returns a prefilled public-records
 * search URL. The CRM card renders these as buttons next to the lane
 * status. Clicking opens the official source in a new tab with the
 * lead's name (and state where applicable) already populated.
 *
 * Why this is "ethically clean" automation:
 *   - NSOPW's TOS forbids automated queries. A pre-filled bookmark
 *     that a human clicks is NOT an automated query — the human
 *     submits it, manually, in their browser. Same logic for Federal
 *     BOP, state DOCs, state bars, and Secretary-of-State portals.
 *   - We never POST data on the operator's behalf. We only build the
 *     URL. The operator's browser session does the search.
 *
 * Coverage by state: incomplete on purpose. We wire the deep-link
 * pattern only for states/jurisdictions where the search URL is
 * documented and stable. For the rest the operator gets a generic
 * "search [state] bar" link via DuckDuckGo's `!bang` resolver, which
 * is still better than typing it manually but worth flagging as the
 * fallback path.
 */
import type { LeadLike } from "./types";

const enc = encodeURIComponent;

// ─── Sex Offender (NSOPW) ──────────────────────────────────────────────────────
// NSOPW deep-link prefills the public web form. The TOS-forbidden activity
// is "automated queries"; a deep-link that a human clicks is not automated.
export function nsopwSearchUrl(lead: LeadLike): string {
  const first = lead.first_name?.trim() ?? "";
  const last = lead.last_name?.trim() ?? "";
  return `https://www.nsopw.gov/Search?firstName=${enc(first)}&lastName=${enc(last)}`;
}

// ─── Federal Bureau of Prisons ─────────────────────────────────────────────────
// BOP's inmate locator accepts GET params. The URL is stable since 2009.
export function bopInmateSearchUrl(lead: LeadLike): string {
  const first = lead.first_name?.trim() ?? "";
  const last = lead.last_name?.trim() ?? "";
  return `https://www.bop.gov/inmateloc/?todo=query&output=html&inmateNum=&nameFirst=${enc(first)}&nameMiddle=&nameLast=${enc(last)}&race=&age=&sex=&output_type=html`;
}

// ─── VINELink (state DOC notification + lookup) ────────────────────────────────
// VINE covers ~46 states' jails and prisons. The public-facing search is at
// vinelink.vineapps.com/search. There's no prefilled-deep-link contract — only
// the landing page with state context — so we send the operator to the state's
// VINE page directly when we have a state.
export function vineLinkSearchUrl(lead: LeadLike): string | null {
  const state = (lead.state ?? "").trim().toUpperCase();
  if (!state) return "https://www.vinelink.com";
  return `https://www.vinelink.com/?state=${enc(state)}`;
}

// ─── State Bar attorney lookups ────────────────────────────────────────────────
// State bar public-search URLs. Coverage is intentionally explicit — keep this
// table small and verified. Adding a state requires (a) confirming the URL
// pattern and (b) ideally a stable query-string for first/last name. Where
// only a landing page is documented, we send the operator there with the
// state code so they can re-paste the name in the form.
const STATE_BAR_URLS: Record<string, (firstName: string, lastName: string) => string> = {
  CA: (f, l) => `https://apps.calbar.ca.gov/attorney/LicenseeSearch/QuickSearch?FreeText=${enc(`${f} ${l}`)}&SoundsLike=false`,
  NY: (f, l) => `https://iapps.courts.state.ny.us/attorneyservices/search?lastName=${enc(l)}&firstName=${enc(f)}`,
  TX: (f, l) => `https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer&template=/CustomSource/MemberDirectory/Search_form_client_main.cfm&LastName=${enc(l)}&FirstName=${enc(f)}`,
  FL: (f, l) => `https://www.floridabar.org/directories/find-mbr/?fnmt=${enc(f)}&lnmt=${enc(l)}`,
  IL: (f, l) => `https://www.iardc.org/lawyersearch.aspx?ln=${enc(l)}&fn=${enc(f)}`,
  PA: (f, l) => `https://www.padisciplinaryboard.org/for-the-public/find-attorney?lastName=${enc(l)}&firstName=${enc(f)}`,
  OH: (f, l) => `https://www.ohiosupremecourt.gov/AttySvcs/AttyReg/?LastName=${enc(l)}&FirstName=${enc(f)}`,
  GA: (f, l) => `https://www.gabar.org/membersearchresults.cfm?lname=${enc(l)}&fname=${enc(f)}`,
  NC: (f, l) => `https://www.ncbar.gov/for-the-public/find-a-lawyer/?fname=${enc(f)}&lname=${enc(l)}`,
  WA: (f, l) => `https://www.mywsba.org/PersonifyEbusiness/LegalDirectory.aspx?ST_NAMEL=${enc(l)}&ST_NAMEF=${enc(f)}`,
};

export function stateBarSearchUrl(lead: LeadLike): { url: string; coverage: "deep_link" | "landing_page" } {
  const first = lead.first_name?.trim() ?? "";
  const last = lead.last_name?.trim() ?? "";
  const state = (lead.state ?? "").trim().toUpperCase();
  const builder = STATE_BAR_URLS[state];
  if (builder) return { url: builder(first, last), coverage: "deep_link" };
  // Fallback: DuckDuckGo bang to the most likely state bar page. Not as good
  // as a real deep-link but better than asking the operator to type.
  const q = `${first} ${last} ${state || ""} state bar attorney lookup`.trim();
  return { url: `https://duckduckgo.com/?q=!ducky+${enc(q)}`, coverage: "landing_page" };
}

// ─── Secretary of State business-entity lookups ────────────────────────────────
// Same pattern as state bar: wire the states where the URL is documented and
// stable. SoS systems are notoriously hostile to deep-linking; this is a
// minimum-viable set focused on the largest jurisdictions.
const STATE_SOS_URLS: Record<string, (businessName: string) => string> = {
  CA: (n) => `https://bizfileonline.sos.ca.gov/search/business?SearchType=Keyword&SearchCriteria=${enc(n)}&SearchSubType=Keyword`,
  DE: (n) => `https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx?entityName=${enc(n)}`,
  NY: (n) => `https://apps.dos.ny.gov/publicInquiry/EntitySearch?entityName=${enc(n)}`,
  TX: (n) => `https://mycpa.cpa.state.tx.us/coa/Index.html?searchName=${enc(n)}`,
  FL: (n) => `https://search.sunbiz.org/Inquiry/CorporationSearch/ByName?searchNameOrder=${enc(n)}`,
  IL: (n) => `https://apps.ilsos.gov/businessentitysearch/?ENTITY_NAME=${enc(n)}`,
};

export function stateSosSearchUrl(lead: LeadLike): { url: string; coverage: "deep_link" | "landing_page" } | null {
  const name = lead.business_name?.trim();
  if (!name) return null;
  const state = (lead.state ?? "").trim().toUpperCase();
  const builder = STATE_SOS_URLS[state];
  if (builder) return { url: builder(name), coverage: "deep_link" };
  return {
    url: `https://duckduckgo.com/?q=!ducky+${enc(`${name} ${state || ""} secretary of state business entity search`)}`,
    coverage: "landing_page",
  };
}

// ─── County property records (residency) ───────────────────────────────────────
// 3000 counties, no unified URL pattern. We send the operator to a state-level
// search page where one exists, otherwise to a DuckDuckGo bang. Florida and
// Texas have unusually good county-aggregator portals.
const STATE_PROPERTY_URLS: Record<string, (city: string, state: string) => string> = {
  FL: (c, _) => `https://duckduckgo.com/?q=!ducky+${enc(`${c} florida property appraiser`)}`,
  TX: (c, _) => `https://duckduckgo.com/?q=!ducky+${enc(`${c} texas appraisal district`)}`,
  CA: (c, _) => `https://duckduckgo.com/?q=!ducky+${enc(`${c} california county assessor`)}`,
};

export function propertyRecordsSearchUrl(lead: LeadLike): string | null {
  const state = (lead.state ?? "").trim().toUpperCase();
  const city = (lead.city ?? "").trim();
  if (!state || !city) return null;
  const builder = STATE_PROPERTY_URLS[state];
  if (builder) return builder(city, state);
  return `https://duckduckgo.com/?q=!ducky+${enc(`${city} ${state} county property records assessor`)}`;
}
