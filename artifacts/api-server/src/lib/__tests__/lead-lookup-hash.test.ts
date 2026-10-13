import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { leadLookupHash } from "../lead-lookup-hash";

test("leadLookupHash: computes correct sha256 for valid input", () => {
  const hash = leadLookupHash("camp_lejeune", "Jane.Doe@Example.com", "+1 (555) 019-2834");

  // Manual expected norm: "camp_lejeune|jane.doe@example.com|5550192834"
  const expectedNorm = "camp_lejeune|jane.doe@example.com|5550192834";
  const expectedHash = crypto.createHash("sha256").update(expectedNorm).digest("hex");

  assert.equal(hash, expectedHash);
});

test("leadLookupHash: handles formatting, whitespace and case variations consistently", () => {
  const h1 = leadLookupHash("  Camp_Lejeune  ", "JANE.DOE@EXAMPLE.COM", "555.019.2834");
  const h2 = leadLookupHash("camp_lejeune", "jane.doe@example.com", "+1-555-019-2834");

  assert.notEqual(h1, null);
  assert.equal(h1, h2);
});

test("leadLookupHash: returns null if any component is missing or incomplete", () => {
  // Missing or empty tort
  assert.equal(leadLookupHash(null, "jane@example.com", "5550192834"), null);
  assert.equal(leadLookupHash(undefined, "jane@example.com", "5550192834"), null);
  assert.equal(leadLookupHash("   ", "jane@example.com", "5550192834"), null);

  // Missing or empty email
  assert.equal(leadLookupHash("roundup", null, "5550192834"), null);
  assert.equal(leadLookupHash("roundup", undefined, "5550192834"), null);
  assert.equal(leadLookupHash("roundup", "   ", "5550192834"), null);

  // Missing, empty, or short phone (< 10 digits)
  assert.equal(leadLookupHash("roundup", "jane@example.com", null), null);
  assert.equal(leadLookupHash("roundup", "jane@example.com", undefined), null);
  assert.equal(leadLookupHash("roundup", "jane@example.com", ""), null);
  assert.equal(leadLookupHash("roundup", "jane@example.com", "555-1234"), null); // 7 digits
});

test("leadLookupHash: correctly extracts last 10 digits when country code or 11+ digits exist", () => {
  const h1 = leadLookupHash("zantac", "user@test.com", "15550192834");
  const h2 = leadLookupHash("zantac", "user@test.com", "5550192834");

  assert.equal(h1, h2);
});
