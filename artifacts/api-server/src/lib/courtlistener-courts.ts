/**
 * CourtListener federal court ID catalog, organized by US state.
 *
 * CourtListener's v4 search API does NOT support a `state=` filter on
 * `type=r` (RECAP/PACER) queries. The supported filter is `court=<id>` (or
 * `court=id1,id2,...` CSV) where each ID is one of the well-known court
 * abbreviations returned by GET /api/rest/v4/courts/.
 *
 * This catalog covers federal district courts (jurisdiction=FD) and
 * federal bankruptcy courts (jurisdiction=FB) for every US state, DC,
 * and US territories. State-court criminal records are NOT in CourtListener
 * and would require a separate background check provider.
 *
 * Catalog sourced from CourtListener API (see scripts/fetch-courts.sh)
 * and verified against https://www.courtlistener.com/help/api/jurisdictions/
 */

const STATE_COURT_IDS: Record<string, readonly string[]> = {
  AL: ["ald", "almd", "alnd", "alsd", "almb", "alnb", "alsb"],
  AK: ["akd", "akb"],
  AZ: ["azd", "arb"],
  AR: ["ard", "ared", "arwd", "areb", "arwb"],
  CA: ["californiad", "cacd", "caed", "cand", "casd", "cacb", "caeb", "canb", "casb"],
  CO: ["cod", "cob"],
  CT: ["ctd", "ctb"],
  DE: ["ded", "deb"],
  DC: ["dcd", "dcb"],
  FL: ["fld", "flmd", "flnd", "flsd", "flmb", "flnb", "flsb"],
  GA: ["gad", "gamd", "gand", "gasd", "gamb", "ganb", "gasb"],
  HI: ["hid", "hib"],
  ID: ["idd", "idb"],
  IL: ["illinoisd", "illinoised", "ilcd", "ilnd", "ilsd", "ilcb", "ilnb", "ilsb"],
  IN: ["indianad", "innd", "insd", "innb", "insb"],
  IA: ["iad", "iand", "iasd", "ianb", "iasb"],
  KS: ["ksd", "ksb"],
  KY: ["kyd", "kyed", "kywd", "kyeb", "kywb"],
  LA: ["lad", "laed", "lamd", "lawd", "laeb", "lamb", "lawb"],
  ME: ["med", "meb"],
  MD: ["mdd", "mdb"],
  MA: ["mad", "mab"],
  MI: ["michd", "mied", "miwd", "mieb", "miwb"],
  MN: ["mnd", "mnb"],
  MS: ["missd", "msnd", "mssd", "msnb", "mssb"],
  MO: ["mod", "moed", "mowd", "moeb", "mowb"],
  MT: ["mtd", "mtb"],
  NE: ["ned", "nebraskab"],
  NV: ["nvd", "nvb"],
  NH: ["nhd", "nhb"],
  NJ: ["njd", "njb"],
  NM: ["nmd", "nmb"],
  NY: ["nyd", "nyed", "nynd", "nysd", "nywd", "nyeb", "nynb", "nysb", "nywb"],
  NC: ["ncd", "nced", "ncmd", "ncwd", "nceb", "ncmb", "ncwb"],
  ND: ["ndd", "ndb"],
  OH: ["ohiod", "ohnd", "ohsd", "ohnb", "ohsb"],
  OK: ["okd", "oked", "oknd", "okwd", "okeb", "oknb", "okwb"],
  OR: ["ord", "orb"],
  PA: ["pennsylvaniad", "paed", "pamd", "pawd", "paeb", "pamb", "pawb"],
  RI: ["rid", "rib"],
  SC: ["scd", "southcarolinaed", "southcarolinawd", "scb"],
  SD: ["sdd", "sdb"],
  TN: ["tennessed", "tned", "tnmd", "tnwd", "tneb", "tnmb", "tnwb", "tennesseeb"],
  TX: ["texd", "txed", "txnd", "txsd", "txwd", "txeb", "txnb", "txsb", "txwb"],
  UT: ["utd", "utb"],
  VT: ["vtd", "vtb"],
  VA: ["vad", "vaed", "vawd", "vaeb", "vawb"],
  WA: ["washd", "waed", "wawd", "waeb", "wawb"],
  WV: ["wvad", "wvnd", "wvsd", "wvnb", "wvsb"],
  WI: ["wisd", "wied", "wiwd", "wieb", "wiwb"],
  WY: ["wyd", "wyb"],
  // US Territories
  PR: ["prd", "prb"],
  GU: ["gud", "gub"],
  VI: ["vid", "vib"],
  MP: ["nmid", "nmib"],
  AS: [], // American Samoa — no separate federal district; cases go to dchi or DC
};

const STATE_LABELS: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  PR: "Puerto Rico", GU: "Guam", VI: "Virgin Islands",
  MP: "Northern Mariana Islands", AS: "American Samoa",
};

// Static reverse lookup dictionary (null prototype) for fast O(1) state name normalization without allocations, linear scans, or prototype leaks.
const LOWER_STATE_NAME_TO_CODE: Record<string, string> = Object.create(null);
for (const code in STATE_LABELS) {
  LOWER_STATE_NAME_TO_CODE[STATE_LABELS[code].toLowerCase()] = code;
}

/**
 * Normalize a state input to a 2-letter US state code, or null if unknown.
 * Accepts:
 *   - 2-letter codes (case-insensitive): "NJ", "nj"
 *   - Full state names (case-insensitive): "New Jersey", "north carolina"
 */
export function normalizeStateCode(state: string | null | undefined): string | null {
  if (!state) return null;
  const trimmed = state.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && STATE_COURT_IDS[upper] !== undefined) {
    return upper;
  }

  const lower = trimmed.toLowerCase();
  return LOWER_STATE_NAME_TO_CODE[lower] ?? null;
}

/**
 * Return the list of CourtListener court IDs that should be queried for the
 * given US state. Returns an empty array when the state is unknown or has no
 * federal court coverage in CourtListener.
 *
 * The return value can be passed directly to CourtListener as a CSV via
 * `&court=<ids.join(",")>`.
 */
export function getCourtsForState(state: string | null | undefined): string[] {
  const code = normalizeStateCode(state);
  if (!code) return [];
  return [...(STATE_COURT_IDS[code] ?? [])];
}

/**
 * Return the human-readable state name for display, or null if unknown.
 */
export function getStateLabel(state: string | null | undefined): string | null {
  const code = normalizeStateCode(state);
  if (!code) return null;
  return STATE_LABELS[code] ?? null;
}

/**
 * Internal helper for tests — exposes the catalog so tests can verify
 * coverage without importing the private constant.
 */
export function _getCatalog(): Record<string, readonly string[]> {
  return STATE_COURT_IDS;
}
