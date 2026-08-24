import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCourtsForState,
  getStateLabel,
  normalizeStateCode,
  _getCatalog,
} from "../courtlistener-courts";
import { nameMatchesResult } from "../background-check";

test("normalizeStateCode: 2-letter codes are normalized", () => {
  assert.equal(normalizeStateCode("nj"), "NJ");
  assert.equal(normalizeStateCode("NJ"), "NJ");
  assert.equal(normalizeStateCode(" NJ "), "NJ");
});

test("normalizeStateCode: full state names map to codes", () => {
  assert.equal(normalizeStateCode("New Jersey"), "NJ");
  assert.equal(normalizeStateCode("north carolina"), "NC");
  assert.equal(normalizeStateCode("DISTRICT OF COLUMBIA"), "DC");
});

test("normalizeStateCode: unknown inputs return null", () => {
  assert.equal(normalizeStateCode(""), null);
  assert.equal(normalizeStateCode(null), null);
  assert.equal(normalizeStateCode(undefined), null);
  assert.equal(normalizeStateCode("ZZ"), null);
  assert.equal(normalizeStateCode("Atlantis"), null);
  assert.equal(normalizeStateCode("toString"), null);
  assert.equal(normalizeStateCode("constructor"), null);
  assert.equal(normalizeStateCode("valueOf"), null);
});

test("getCourtsForState: every US state + DC has at least one federal court", () => {
  const stateCodes = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA",
    "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
    "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX",
    "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  ];
  for (const code of stateCodes) {
    const courts = getCourtsForState(code);
    assert.ok(courts.length > 0, `${code} should have at least one federal court ID`);
    assert.equal(getStateLabel(code) !== null, true, `${code} should have a label`);
  }
});

test("getCourtsForState: well-known mappings are correct", () => {
  // Spot-check a few critical states against the actual CourtListener catalog
  const nj = getCourtsForState("NJ");
  assert.deepEqual(nj.sort(), ["njb", "njd"].sort(), "NJ should be njd + njb");

  const nc = getCourtsForState("NC");
  assert.ok(nc.includes("nced"), "NC should include E.D.N.C. (nced)");
  assert.ok(nc.includes("ncmd"), "NC should include M.D.N.C. (ncmd)");
  assert.ok(nc.includes("ncwd"), "NC should include W.D.N.C. (ncwd)");
  assert.ok(nc.includes("nceb"), "NC should include E.D.N.C. bankruptcy");

  const ca = getCourtsForState("CA");
  for (const id of ["cacd", "caed", "cand", "casd", "cacb", "caeb", "canb", "casb"]) {
    assert.ok(ca.includes(id), `CA should include ${id}`);
  }
});

test("getCourtsForState: unknown returns empty", () => {
  assert.deepEqual(getCourtsForState("ZZ"), []);
  assert.deepEqual(getCourtsForState(undefined), []);
  assert.deepEqual(getCourtsForState(""), []);
});

test("catalog uses only lowercase ASCII court IDs (matches CourtListener API)", () => {
  const catalog = _getCatalog();
  for (const [state, ids] of Object.entries(catalog)) {
    for (const id of ids) {
      assert.match(id, /^[a-z0-9]+$/, `court id "${id}" for state ${state} must be lowercase alnum`);
    }
  }
});

// === False-positive matching tests — the core bug behind the
// "Giselle Pereira" complaint ===

test("nameMatchesResult: 'X v. Pereira' WITHOUT first-name evidence is rejected", () => {
  const result = {
    caseName: "SCIPPIO v. PEREIRA",
    party: ["SCIPPIO", "PEREIRA"],
    recap_documents: [],
  };
  const m = nameMatchesResult(result, "Giselle", "Pereira");
  assert.equal(m.match, false, "Surname-only defendant match must be rejected");
});

test("nameMatchesResult: 'X v. Pereira' WITH 'Giselle' in recap docs is matched", () => {
  const result = {
    caseName: "SCIPPIO v. PEREIRA",
    party: ["SCIPPIO", "PEREIRA"],
    recap_documents: [
      { description: "Motion to dismiss filed by Giselle Pereira", snippet: "" },
    ],
  };
  const m = nameMatchesResult(result, "Giselle", "Pereira");
  assert.equal(m.match, true);
  assert.equal(m.role, "party");
  assert.equal(m.confidence, "strong");
});

test("nameMatchesResult: exact 'Giselle Pereira' in case name is high-confidence party", () => {
  const result = {
    caseName: "Giselle Pereira v. Acme Corp",
    party: ["Giselle Pereira", "Acme Corp"],
  };
  const m = nameMatchesResult(result, "Giselle", "Pereira");
  assert.equal(m.match, true);
  assert.equal(m.role, "party");
  assert.equal(m.confidence, "exact");
});

test("nameMatchesResult: name initial 'Pereira, G.' is matched as strong party", () => {
  const result = {
    caseName: "United States v. Pereira, G.",
    party: ["United States", "Pereira, G."],
  };
  const m = nameMatchesResult(result, "Giselle", "Pereira");
  assert.equal(m.match, true);
  assert.equal(m.role, "party");
});

test("nameMatchesResult: case mentioning name only in document text is 'mentioned'", () => {
  const result = {
    caseName: "United States v. Klein",
    party: ["United States", "Klein"],
    recap_documents: [
      { description: "Witness Giselle Pereira testified on Tuesday", snippet: "" },
    ],
  };
  const m = nameMatchesResult(result, "Giselle", "Pereira");
  assert.equal(m.match, true);
  assert.equal(m.role, "mentioned");
});

test("nameMatchesResult: completely unrelated case is not matched", () => {
  const result = {
    caseName: "Smith v. Jones",
    party: ["Smith", "Jones"],
    recap_documents: [{ description: "Routine filing", snippet: "Nothing to see" }],
  };
  const m = nameMatchesResult(result, "Giselle", "Pereira");
  assert.equal(m.match, false);
});
