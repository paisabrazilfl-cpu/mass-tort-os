import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFaxNumber, FaxNumberSchema } from "../fax/normalize";

test("normalizeFaxNumber: accepts common human formats", () => {
  for (const raw of [
    "6144552138",
    "(614) 455-2138",
    "614.455.2138",
    "614-455-2138",
    "+1 614 455 2138",
    "1-614-455-2138",
    "  614 455 2138 ext 5 ",
  ]) {
    const out = normalizeFaxNumber(raw);
    assert.equal(out.ok, true, `expected ok for ${raw}`);
    if (out.ok) {
      assert.equal(out.tenDigit, "6144552138");
      assert.equal(out.e164, "+16144552138");
    }
  }
});

test("normalizeFaxNumber: rejects empty / short / long", () => {
  for (const raw of ["", "   ", "555123", "61445521380000"]) {
    const out = normalizeFaxNumber(raw);
    assert.equal(out.ok, false, `expected fail for ${JSON.stringify(raw)}`);
  }
  assert.equal(normalizeFaxNumber(null).ok, false);
  assert.equal(normalizeFaxNumber(undefined).ok, false);
});

test("normalizeFaxNumber: rejects NANP-impossible area / exchange", () => {
  assert.equal(normalizeFaxNumber("0144552138").ok, false);
  assert.equal(normalizeFaxNumber("1144552138").ok, false);
  assert.equal(normalizeFaxNumber("6140552138").ok, false);
  assert.equal(normalizeFaxNumber("6141552138").ok, false);
});

test("normalizeFaxNumber: rejects all-same-digit garbage", () => {
  assert.equal(normalizeFaxNumber("9999999999").ok, false);
  assert.equal(normalizeFaxNumber("0000000000").ok, false);
});

test("FaxNumberSchema: parses to E.164", () => {
  const ok = FaxNumberSchema.safeParse("(614) 455-2138");
  assert.equal(ok.success, true);
  if (ok.success) assert.equal(ok.data, "+16144552138");

  const bad = FaxNumberSchema.safeParse("not a phone");
  assert.equal(bad.success, false);
});
