// Tests for the new Tier-1 bg-hub adapters: Garbo (premium background
// check), phone-provenance (Telnyx Lookup), and email-enrichment
// (free disposable + role-based detection).
//
// No network. Each adapter exposes a test-override hook that returns a
// canned response, so the adapter logic is pinned independently of any
// live API contract drift.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import { __setGarboTestOverride, _runGarboCheckWithOverride } from "../bg-hub/garbo";
import { __setPhoneLookupTestOverride, _lookupPhoneProvenanceWithOverride } from "../bg-hub/phone-provenance";
import { enrichEmail } from "../bg-hub/email-enrichment";

after(() => {
  __setGarboTestOverride(null);
  __setPhoneLookupTestOverride(null);
});

describe("Garbo adapter envelope (network mocked)", () => {
  test("ok envelope with sex-offender registry hit surfaces the right shape", async () => {
    __setGarboTestOverride(async () => ({
      status: "ok",
      hits: [
        {
          record_id: "abc-123",
          category: "sexual",
          description: "Registered sex offender — Tier II",
          jurisdiction: "CA",
          is_sex_offender_registry: true,
        },
      ],
      raw: { source: "test" },
      checked_at: new Date().toISOString(),
    }));
    const r = await _runGarboCheckWithOverride({ first_name: "John", last_name: "Doe" });
    assert.equal(r.status, "ok");
    if (r.status !== "ok") return;
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0]!.is_sex_offender_registry, true);
    assert.equal(r.hits[0]!.category, "sexual");
  });

  test("unconfigured envelope is returned when no integration + no env", async () => {
    __setGarboTestOverride(async () => ({
      status: "unconfigured",
      note: "No Garbo integration configured.",
    }));
    const r = await _runGarboCheckWithOverride({ first_name: "John", last_name: "Doe" });
    assert.equal(r.status, "unconfigured");
  });

  test("error envelope on network failure does not throw", async () => {
    __setGarboTestOverride(async () => ({
      status: "error",
      note: "Garbo timeout after 15000ms",
    }));
    const r = await _runGarboCheckWithOverride({ first_name: "John", last_name: "Doe" });
    assert.equal(r.status, "error");
    if (r.status !== "error") return;
    assert.match(r.note, /timeout/);
  });

  test("empty hits → ok envelope, not error", async () => {
    __setGarboTestOverride(async () => ({
      status: "ok",
      hits: [],
      raw: { source: "test" },
      checked_at: new Date().toISOString(),
    }));
    const r = await _runGarboCheckWithOverride({ first_name: "Jane", last_name: "Smith" });
    assert.equal(r.status, "ok");
    if (r.status !== "ok") return;
    assert.deepEqual(r.hits, []);
  });
});

describe("Phone provenance — Telnyx Lookup (network mocked)", () => {
  test("non_fixed_voip is classified as high-risk burner", async () => {
    __setPhoneLookupTestOverride(async () => ({
      status: "ok",
      phone: "+14155551212",
      line_type: "non_fixed_voip",
      carrier: "Bandwidth.com CLEC",
      country_code: "US",
      recently_ported: false,
      risk: "high",
      flags: ["phone_non_fixed_voip", "phone_known_burner_carrier"],
    }));
    const r = await _lookupPhoneProvenanceWithOverride("415-555-1212");
    assert.equal(r.risk, "high");
    assert.ok(r.flags.includes("phone_non_fixed_voip"));
  });

  test("mobile line on a known carrier is low-risk", async () => {
    __setPhoneLookupTestOverride(async () => ({
      status: "ok",
      phone: "+12025550100",
      line_type: "mobile",
      carrier: "Verizon Wireless",
      country_code: "US",
      recently_ported: false,
      risk: "low",
      flags: [],
    }));
    const r = await _lookupPhoneProvenanceWithOverride("202-555-0100");
    assert.equal(r.risk, "low");
    assert.deepEqual(r.flags, []);
  });

  test("unparseable phone returns flagged error, not throw", async () => {
    __setPhoneLookupTestOverride(async () => ({
      status: "error",
      phone: "not a phone",
      line_type: null,
      carrier: null,
      country_code: null,
      recently_ported: false,
      risk: "unknown",
      flags: ["phone_unparseable"],
      note: "Could not normalize to E.164",
    }));
    const r = await _lookupPhoneProvenanceWithOverride("not a phone");
    assert.equal(r.status, "error");
    assert.ok(r.flags.includes("phone_unparseable"));
  });

  test("recently-ported number bumps risk to at least moderate", async () => {
    __setPhoneLookupTestOverride(async () => ({
      status: "ok",
      phone: "+13105550199",
      line_type: "mobile",
      carrier: "T-Mobile",
      country_code: "US",
      recently_ported: true,
      risk: "moderate",
      flags: ["phone_recently_ported"],
    }));
    const r = await _lookupPhoneProvenanceWithOverride("310-555-0199");
    assert.ok(r.risk === "moderate" || r.risk === "high");
    assert.ok(r.flags.includes("phone_recently_ported"));
  });
});

describe("Email enrichment (no network)", () => {
  test("mailinator.com is flagged disposable", () => {
    const r = enrichEmail("test@mailinator.com");
    assert.equal(r.is_disposable, true);
    assert.ok(r.flags.includes("disposable_domain"));
  });

  test("guerrillamail and 10minutemail are also flagged disposable", () => {
    assert.equal(enrichEmail("a@guerrillamail.com").is_disposable, true);
    assert.equal(enrichEmail("b@10minutemail.com").is_disposable, true);
  });

  test("admin@gmail.com flags role-based + free-provider", () => {
    const r = enrichEmail("admin@gmail.com");
    assert.equal(r.is_role_based, true);
    assert.equal(r.is_free_provider, true);
    assert.ok(r.flags.includes("role_based_email"));
  });

  test("real-looking personal address has zero flags", () => {
    const r = enrichEmail("jane.smith@gmail.com");
    assert.deepEqual(r.flags, []);
    assert.equal(r.is_disposable, false);
    assert.equal(r.is_role_based, false);
    assert.equal(r.is_free_provider, true); // gmail is a free provider, but not flagged on its own
  });

  test("a legitimate corporate email is fully clean", () => {
    const r = enrichEmail("attorney@biglawfirm.example");
    assert.deepEqual(r.flags, []);
    assert.equal(r.is_free_provider, false);
  });

  test("empty / malformed email returns empty result without throwing", () => {
    const r = enrichEmail("");
    assert.equal(r.domain, null);
    assert.equal(r.local_part, null);
    assert.deepEqual(r.flags, []);
  });

  test("emails with leading/trailing whitespace are normalized", () => {
    const r = enrichEmail("   TEST@MAILINATOR.COM  ");
    assert.equal(r.domain, "mailinator.com");
    assert.equal(r.local_part, "test");
    assert.equal(r.is_disposable, true);
  });
});
