// Tests for bg-hub smart-link URL generators. These produce prefilled
// public-records search URLs that the operator clicks; we never POST
// data on their behalf. The tests guard against three regressions:
//
//   (1) The URL must be valid and parseable.
//   (2) The lead's name + state must actually appear in the query
//       string — a smart-link with no prefill is just a bookmark.
//   (3) When a state-specific deep-link is documented, we use it
//       (not the DuckDuckGo fallback). Tests pin the deep-link path
//       for the wired states and the fallback path for an unwired
//       state.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  bopInmateSearchUrl,
  nsopwSearchUrl,
  propertyRecordsSearchUrl,
  stateBarSearchUrl,
  stateSosSearchUrl,
  vineLinkSearchUrl,
} from "../bg-hub/smart-links";
import type { LeadLike } from "../bg-hub/types";

const exampleLead = (overrides: Partial<LeadLike> = {}): LeadLike => ({
  id: 1,
  first_name: "Jane",
  last_name: "Doe",
  state: "CA",
  city: "Los Angeles",
  zip: "90001",
  business_name: "ExampleCo Inc",
  ...overrides,
});

function paramsOf(urlString: string): URLSearchParams {
  return new URL(urlString).searchParams;
}

describe("smart-links: NSOPW", () => {
  test("prefills firstName + lastName on the NSOPW search URL", () => {
    const url = nsopwSearchUrl(exampleLead());
    assert.ok(url.startsWith("https://www.nsopw.gov/Search"));
    const p = paramsOf(url);
    assert.equal(p.get("firstName"), "Jane");
    assert.equal(p.get("lastName"), "Doe");
  });
});

describe("smart-links: Federal BOP", () => {
  test("prefills first + last name on the inmate locator URL", () => {
    const url = bopInmateSearchUrl(exampleLead());
    assert.ok(url.startsWith("https://www.bop.gov/inmateloc/"));
    const p = paramsOf(url);
    assert.equal(p.get("nameFirst"), "Jane");
    assert.equal(p.get("nameLast"), "Doe");
    assert.equal(p.get("todo"), "query");
  });
});

describe("smart-links: VINELink", () => {
  test("routes to the state landing when state present", () => {
    const url = vineLinkSearchUrl(exampleLead({ state: "CA" }));
    assert.ok(url);
    assert.match(url!, /state=CA/);
  });

  test("falls back to root URL when no state", () => {
    const url = vineLinkSearchUrl(exampleLead({ state: null }));
    assert.equal(url, "https://www.vinelink.com");
  });
});

describe("smart-links: state bar lookups", () => {
  test("CA uses the calbar QuickSearch deep-link with the lead name", () => {
    const r = stateBarSearchUrl(exampleLead({ state: "CA" }));
    assert.equal(r.coverage, "deep_link");
    assert.ok(r.url.includes("calbar.ca.gov"));
    assert.ok(r.url.includes("Jane%20Doe"));
  });

  test("NY uses the courts.state.ny.us deep-link with split name", () => {
    const r = stateBarSearchUrl(exampleLead({ state: "NY" }));
    assert.equal(r.coverage, "deep_link");
    assert.match(r.url, /firstName=Jane/);
    assert.match(r.url, /lastName=Doe/);
  });

  test("unwired state falls back to DuckDuckGo bang", () => {
    const r = stateBarSearchUrl(exampleLead({ state: "AK" })); // not in the map
    assert.equal(r.coverage, "landing_page");
    assert.ok(r.url.startsWith("https://duckduckgo.com/"));
    assert.match(decodeURIComponent(r.url), /Jane Doe AK state bar/);
  });
});

describe("smart-links: Secretary-of-State business search", () => {
  test("returns null when the lead has no business_name", () => {
    const r = stateSosSearchUrl(exampleLead({ business_name: null }));
    assert.equal(r, null);
  });

  test("CA bizfile deep-link includes the business name", () => {
    const r = stateSosSearchUrl(exampleLead({ state: "CA", business_name: "Acme Widgets LLC" }));
    assert.ok(r);
    assert.equal(r!.coverage, "deep_link");
    assert.ok(r!.url.includes("bizfileonline.sos.ca.gov"));
    assert.ok(decodeURIComponent(r!.url).includes("Acme Widgets LLC"));
  });

  test("unwired state falls back to DuckDuckGo bang", () => {
    const r = stateSosSearchUrl(exampleLead({ state: "VT", business_name: "Maple Co" }));
    assert.ok(r);
    assert.equal(r!.coverage, "landing_page");
    assert.match(decodeURIComponent(r!.url), /Maple Co VT secretary of state/);
  });
});

describe("smart-links: property records", () => {
  test("requires both state and city to emit a URL", () => {
    assert.equal(propertyRecordsSearchUrl(exampleLead({ state: null })), null);
    assert.equal(propertyRecordsSearchUrl(exampleLead({ city: null })), null);
  });

  test("FL routes to a FL appraiser query", () => {
    const url = propertyRecordsSearchUrl(exampleLead({ state: "FL", city: "Miami" }));
    assert.ok(url);
    assert.match(decodeURIComponent(url!), /Miami florida property appraiser/);
  });

  test("unmapped state falls back to a generic assessor search", () => {
    const url = propertyRecordsSearchUrl(exampleLead({ state: "VT", city: "Burlington" }));
    assert.ok(url);
    assert.match(decodeURIComponent(url!), /Burlington VT county property records assessor/);
  });
});
