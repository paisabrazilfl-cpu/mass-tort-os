import type { BackgroundLane, BackgroundSource } from "./types";

// Authoritative URLs the operator can consult for each lane. The
// `live_adapter_available` flag tells the UI whether the result came from a
// real adapter or whether the operator should click through and check
// manually. Keep this list in sync with adapters.ts — every lane that has a
// live adapter must have at least one source with live_adapter_available=true.
//
// Sourcing notes:
//   - URLs are public official sources (federal agencies, free aggregators).
//   - Marking requires_api_key=true means the live adapter cannot run unless
//     a credential is configured (currently honored only for OFAC via env
//     var; future Twilio/USPS/SAM.gov adapters should follow the same
//     "unconfigured ≠ pass" pattern as background-check.ts checkOFACList).
export const BACKGROUND_SOURCES: Record<BackgroundLane, readonly BackgroundSource[]> = {
  address: [
    {
      name: "Internal address validator",
      url: "https://github.com/usnistgov/libpostal",
      source_type: "technical",
      requires_api_key: false,
      live_adapter_available: true,
      notes: "Format/USPS-style validation built into MTOS (lib/address-validator.ts).",
    },
    {
      name: "USPS Address Validation API",
      url: "https://www.usps.com/business/web-tools-apis/address-information-api.htm",
      source_type: "primary",
      requires_api_key: true,
      live_adapter_available: false,
    },
    {
      name: "Census Geocoder",
      url: "https://geocoding.geo.census.gov/",
      source_type: "federal",
      requires_api_key: false,
      live_adapter_available: false,
    },
    {
      name: "County Property Records Directory",
      url: "https://publicrecords.netronline.com/",
      source_type: "directory",
      requires_api_key: false,
      live_adapter_available: false,
    },
  ],

  email: [
    {
      name: "Internal email validator",
      url: "https://datatracker.ietf.org/doc/html/rfc5322",
      source_type: "technical",
      requires_api_key: false,
      live_adapter_available: true,
      notes: "RFC format + MX DNS + typo correction + disposable-domain block (lib/email-validator.ts).",
    },
    {
      name: "ICANN Lookup",
      url: "https://lookup.icann.org/",
      source_type: "technical",
      requires_api_key: false,
      live_adapter_available: false,
    },
  ],

  phone: [
    {
      name: "Internal phone format check",
      url: "https://www.itu.int/rec/T-REC-E.164/",
      source_type: "technical",
      requires_api_key: false,
      live_adapter_available: true,
      notes: "Length/format validation only. No carrier or reassignment check.",
    },
    {
      name: "Twilio Lookup",
      url: "https://www.twilio.com/lookup",
      source_type: "technical",
      requires_api_key: true,
      live_adapter_available: false,
    },
    {
      name: "FCC Reassigned Numbers Database",
      url: "https://www.reassigned.us/",
      source_type: "federal",
      requires_api_key: true,
      live_adapter_available: false,
    },
  ],

  residency: [
    {
      name: "US Census Geocoder",
      url: "https://geocoding.geo.census.gov/geocoder/",
      source_type: "federal",
      requires_api_key: false,
      live_adapter_available: true,
      notes: "Free federal geocoder — confirms address exists in TIGER/Line dataset. Not proof of residency, but catches fabricated addresses. No API key required.",
    },
    {
      name: "County Property Records Directory",
      url: "https://publicrecords.netronline.com/",
      source_type: "directory",
      requires_api_key: false,
      live_adapter_available: false,
      notes: "No live adapter — operator must confirm residency via county property/tax records by hand.",
    },
    {
      name: "Vote.gov",
      url: "https://vote.gov/",
      source_type: "directory",
      requires_api_key: false,
      live_adapter_available: false,
    },
  ],

  criminal_court: [
    {
      name: "CourtListener / RECAP (federal)",
      url: "https://www.courtlistener.com/",
      source_type: "federal",
      requires_api_key: false,
      live_adapter_available: true,
      notes: "Live adapter via lib/background-check.ts — federal districts only.",
    },
    {
      name: "PACER",
      url: "https://pacer.uscourts.gov/",
      source_type: "federal",
      requires_api_key: true,
      live_adapter_available: false,
      notes: "PACER lives in its own dedicated lane (pacer_federal) with a live PCL Search adapter — see below.",
    },
    {
      name: "State Court Websites Directory",
      url: "https://www.ncsc.org/information-and-resources/state-court-websites",
      source_type: "directory",
      requires_api_key: false,
      live_adapter_available: false,
      notes: "State criminal records are NOT covered by the live adapter — operator must check by hand.",
    },
    {
      name: "County Clerk Directory",
      url: "https://publicrecords.netronline.com/",
      source_type: "directory",
      requires_api_key: false,
      live_adapter_available: false,
    },
  ],

  incarceration: [
    {
      name: "Federal BOP Inmate Locator (JSON API)",
      url: "https://www.bop.gov/inmateloc/",
      source_type: "federal",
      requires_api_key: false,
      live_adapter_available: true,
      notes: "Free live adapter — searches federal inmates by first/last name. Covers federal facilities only. State DOC and county jails require manual lookup. CAPTCHA-guarded under bot-detection; adapter returns REVIEW_REQUIRED if triggered.",
    },
    {
      name: "USA.gov State Corrections Directory",
      url: "https://www.usa.gov/corrections",
      source_type: "directory",
      requires_api_key: false,
      live_adapter_available: false,
      notes: "State prisons and county jails — no unified API. Manual lookup required.",
    },
  ],

  sex_offender_nsopw: [
    {
      name: "NSOPW (National Sex Offender Public Website)",
      url: "https://www.nsopw.gov/",
      source_type: "federal",
      requires_api_key: false,
      live_adapter_available: false,
      notes:
        "No fake PASS. Manual lookup required — NSOPW prohibits automated scraping per its terms of use.",
    },
  ],

  attorney: [
    {
      name: "CourtListener RECAP (federal attorney-of-record)",
      url: "https://www.courtlistener.com/api/rest/v4/search/",
      source_type: "federal",
      requires_api_key: false,
      live_adapter_available: true,
      notes: "Free live adapter — searches public RECAP index for the lead's name in attorney-of-record fields. No API key required for public search. Adding a vault-stored CourtListener token (provider=courtlistener) unlocks the /attorneys/ endpoint for higher-fidelity matching. Covers federal courts only.",
    },
    {
      name: "CourtListener /attorneys/ endpoint",
      url: "https://www.courtlistener.com/api/rest/v4/attorneys/",
      source_type: "federal",
      requires_api_key: true,
      live_adapter_available: true,
      notes: "Enhanced attorney lookup via authenticated endpoint. Free API token available at courtlistener.com. Automatically used when courtlistener integration is configured in the vault.",
    },
    {
      name: "ABA Lawyer Licensing Directory",
      url: "https://www.americanbar.org/groups/legal_services/flh-home/flh-lawyer-licensing/",
      source_type: "directory",
      requires_api_key: false,
      live_adapter_available: false,
      notes: "State-by-state bar lookups — no national live adapter. Smart links wired for CA, NY, TX, FL, IL, PA, OH, GA, NC, WA.",
    },
  ],

  pacer_federal: [
    {
      name: "PACER PCL Search API",
      url: "https://pcl.uscourts.gov/pcl/index.jsf",
      source_type: "federal",
      requires_api_key: true,
      live_adapter_available: true,
      notes:
        "Live adapter (lib/pacer/pcl-client.ts) calls the PACER Case Locator Search API using vault-stored PACER credentials. Per-page billing applies — lane returns NOT_RUN when no PACER integration is configured. Hits surface as REVIEW (never auto-FAIL) — operator confirms identity by purchasing the docket.",
    },
    {
      name: "PACER Login",
      url: "https://pacer.login.uscourts.gov/",
      source_type: "federal",
      requires_api_key: true,
      live_adapter_available: false,
      notes: "Token endpoint used by the PCL adapter to exchange username/password for a session cookie.",
    },
  ],

  business_entity: [
    {
      name: "SEC EDGAR (company_tickers index)",
      url: "https://www.sec.gov/cgi-bin/browse-edgar",
      source_type: "federal",
      requires_api_key: false,
      live_adapter_available: true,
      notes: "Free live adapter — searches SEC's 10K+ company ticker index (public companies, large LLCs, Reg-D filers). Cached daily. Does NOT cover small private LLCs — use SoS smart link for those.",
    },
    {
      name: "NASS Corporate Registration Directory",
      url: "https://www.nass.org/business-services/corporate-registration",
      source_type: "directory",
      requires_api_key: false,
      live_adapter_available: false,
      notes: "Secretary of State lookups — smart links wired for CA, DE, NY, TX, FL, IL.",
    },
    {
      name: "SAM.gov Entity Search",
      url: "https://sam.gov/search/",
      source_type: "federal",
      requires_api_key: true,
      live_adapter_available: false,
      notes: "Federal contractor/entity registry. Free API key at beta.sam.gov. Not yet wired.",
    },
    {
      name: "OpenCorporates",
      url: "https://opencorporates.com/",
      source_type: "secondary",
      requires_api_key: true,
      live_adapter_available: false,
      notes: "Paid API token required.",
    },
  ],

  phone_provenance: [
    {
      name: "Telnyx Number Lookup",
      url: "https://developers.telnyx.com/api/lookup",
      source_type: "technical",
      requires_api_key: true,
      live_adapter_available: false,
      notes: "Stub lane — live adapter not yet implemented.",
    },
  ],
};
