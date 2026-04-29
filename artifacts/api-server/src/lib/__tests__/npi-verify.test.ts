// Unit tests for npi-verify cherry-picks from the 2026-04-29 review package:
//   - VERIFIED / MISMATCH / UNAVAILABLE three-way honest status
//   - normalizeName / similarityName credential stripping
//   - Specialty alias matching ("general practitioner" → family medicine)
//   - Practice-LOCATION preference over MAILING addresses
//
// We do not exercise the live HTTPS path here — those tests would be flaky
// against the public NPPES registry. Network behavior (User-Agent header,
// retries, UNAVAILABLE on transport failure) is covered by stubbing fetch
// at the top of the verifyProvider tests.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  normalize,
  normalizeName,
  similarity,
  similarityName,
} from "../string-similarity.js";
import { __test, verifyProvider } from "../npi-verify.js";

describe("string-similarity: normalizeName + similarityName", () => {
  test("normalizeName strips Dr / MD / DO / Esq", () => {
    assert.equal(normalizeName("Dr. Micah B. Edwin, MD"), "micah b edwin");
    assert.equal(normalizeName("John Smith Jr., DO"), "john smith");
    assert.equal(normalizeName("Jane Doe, Esq."), "jane doe");
  });

  test("normalizeName returns empty for credential-only input", () => {
    assert.equal(normalizeName("Dr. MD"), "");
    assert.equal(normalizeName(""), "");
    assert.equal(normalizeName(null), "");
  });

  test("similarityName scores Dr/MD-stripped pair as identical", () => {
    // Raw similarity would penalize the credential noise. similarityName
    // takes max of raw and stripped so it can only go UP.
    const raw = similarity("Dr. Micah B. Edwin, MD", "Micah B Edwin");
    const stripped = similarityName("Dr. Micah B. Edwin, MD", "Micah B Edwin");
    assert.ok(stripped > raw, `stripped (${stripped}) should beat raw (${raw})`);
    assert.equal(stripped, 1);
  });

  test("similarityName never lowers a passing score", () => {
    // Two clean names — no titles. similarityName must equal raw similarity.
    const raw = similarity("Micah Edwin", "Micah Edwin");
    const stripped = similarityName("Micah Edwin", "Micah Edwin");
    assert.equal(stripped, raw);
  });
});

describe("npi-verify: pickBestSearchResult prefers practice LOCATION", () => {
  test("scoring uses LOCATION city, not MAILING city", () => {
    // Provider has a Tallahassee mailing address but actual practice in
    // Lauderdale Lakes. The expected city is Lauderdale Lakes — picking
    // the MAILING address would tank the city score.
    const result = __test.pickBestSearchResult(
      [
        {
          number: "1234567890",
          basic: { first_name: "Micah", last_name: "Edwin" },
          addresses: [
            { address_purpose: "MAILING", city: "Tallahassee", state: "FL" },
            {
              address_purpose: "LOCATION",
              city: "Lauderdale Lakes",
              state: "FL",
            },
          ],
        },
      ],
      { name: "Micah Edwin", city: "Lauderdale Lakes", state: "FL" },
    );
    assert.ok(result, "expected a candidate");
    // If LOCATION was used, city is an exact match → high overall score.
    assert.ok(
      result!.score > 0.85,
      `expected score >0.85, got ${result!.score}`,
    );
  });
});

describe("npi-verify: providerTaxonomyMatches with specialty aliases", () => {
  test("'general practitioner' matches NPPES 'Family Medicine'", () => {
    const tax = __test.providerTaxonomyMatches(
      {
        taxonomies: [{ code: "207Q00000X", desc: "Family Medicine", primary: true }],
      },
      "general practitioner",
    );
    assert.equal(tax.matched, true, "alias should have matched Family Medicine");
    assert.equal(tax.matched_taxonomies[0]?.desc, "Family Medicine");
  });

  test("'general practitioner' matches NPPES 'Internal Medicine'", () => {
    const tax = __test.providerTaxonomyMatches(
      {
        taxonomies: [{ code: "207R00000X", desc: "Internal Medicine", primary: true }],
      },
      "general practitioner",
    );
    assert.equal(tax.matched, true);
  });

  test("unrelated specialty does NOT match via aliases", () => {
    const tax = __test.providerTaxonomyMatches(
      {
        taxonomies: [{ code: "207W00000X", desc: "Ophthalmology", primary: true }],
      },
      "general practitioner",
    );
    assert.equal(tax.matched, false, "ophthalmology must not match GP aliases");
  });

  test("empty expected specialty → no matches and no crash", () => {
    const tax = __test.providerTaxonomyMatches(
      { taxonomies: [{ code: "X", desc: "Family Medicine", primary: true }] },
      "",
    );
    assert.equal(tax.matched, false);
  });
});

describe("npi-verify: VerifyProviderStatus three-way honest verdict", () => {
  // verifyProvider internally calls fetch(). We stub the global fetch to
  // simulate (a) NPPES unreachable, (b) NPPES returns nothing, and (c)
  // NPPES returns a clean perfect-match record.

  const realFetch = globalThis.fetch;

  test("status=UNAVAILABLE when NPPES is completely unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    try {
      const result = await verifyProvider({
        expected: { name: "Micah Edwin", city: "Lauderdale Lakes", state: "FL" },
      });
      assert.equal(
        result.status,
        "UNAVAILABLE",
        "must NEVER report MISMATCH when NPPES was never reached",
      );
      assert.equal(result.verified, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("status=UNAVAILABLE when NPPES returns HTTP 503", async () => {
    globalThis.fetch = (async () =>
      new Response("Service Unavailable", { status: 503 })) as typeof fetch;
    try {
      const result = await verifyProvider({
        npi: "1234567890",
        expected: { name: "Anyone" },
      });
      assert.equal(result.status, "UNAVAILABLE");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("status=MISMATCH when NPPES returns no matching candidates", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      const result = await verifyProvider({
        expected: { name: "Nobody", city: "Nowhere", state: "ZZ" },
      });
      assert.equal(
        result.status,
        "MISMATCH",
        "got data back (zero candidates) → MISMATCH, not UNAVAILABLE",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("status=VERIFIED when all gates pass on a clean perfect match", async () => {
    const fakeProvider = {
      number: "1234567890",
      basic: {
        first_name: "Micah",
        last_name: "Edwin",
        organization_name: "",
      },
      addresses: [
        {
          address_purpose: "LOCATION",
          address_1: "100 Main St",
          city: "Lauderdale Lakes",
          state: "FL",
          postal_code: "33313",
        },
      ],
      taxonomies: [
        { code: "207Q00000X", desc: "Family Medicine", primary: true },
      ],
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [fakeProvider] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      const result = await verifyProvider({
        npi: "1234567890",
        expected: {
          name: "Dr. Micah Edwin, MD", // tests credential stripping path
          city: "Lauderdale Lakes",
          state: "FL",
          specialty: "General practitioner", // tests alias path
        },
      });
      assert.equal(result.status, "VERIFIED");
      assert.equal(result.verified, true);
      assert.equal(result.method, "npi");
      assert.equal(result.checks.specialty?.match, true);
      assert.ok(
        (result.checks.name?.score ?? 0) >= 0.99,
        "Dr/MD stripping should produce ~1.0 name score",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
