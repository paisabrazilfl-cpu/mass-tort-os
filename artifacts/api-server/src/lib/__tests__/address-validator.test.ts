import test from "node:test";
import assert from "node:assert/strict";
import { validateAddress } from "../address-validator";

test("validateAddress: valid US addresses", () => {
  const result1 = validateAddress({
    street_address: "123 Main St",
    city: "Springfield",
    state: "IL",
    zip: "62701",
  });
  assert.equal(result1.valid, true);
  assert.deepEqual(result1.errors, []);

  const result2 = validateAddress({
    street_address: "10045 N 1st Ave Ste 200",
    city: "Los Angeles",
    state: "ca", // lowercase state should normalize
    zip: "90012-1234", // ZIP+4 format
  });
  assert.equal(result2.valid, true);
  assert.deepEqual(result2.errors, []);
});

test("validateAddress: missing fields", () => {
  const result = validateAddress({
    street_address: "  ",
    city: "",
    state: undefined,
    zip: "",
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    "MISSING_STREET",
    "MISSING_CITY",
    "MISSING_STATE",
    "MISSING_ZIP",
  ]);
});

test("validateAddress: invalid formats", () => {
  const result = validateAddress({
    street_address: "NoNumberHere", // missing street number
    city: "A", // too short (< 2 chars)
    state: "XX", // invalid US state code
    zip: "1234", // invalid zip (4 digits)
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    "INVALID_STREET_FORMAT",
    "INVALID_CITY",
    "INVALID_STATE_CODE",
    "INVALID_ZIP_FORMAT",
  ]);
});

test("validateAddress: detects garbage address data", () => {
  const result1 = validateAddress({
    street_address: "asdf",
    city: "test",
    state: "CA",
    zip: "90210",
  });
  assert.equal(result1.valid, false);
  assert.ok(result1.errors.includes("GARBAGE_ADDRESS_DATA"));

  const result2 = validateAddress({
    street_address: "123 Main St",
    city: "000000000",
    state: "NY",
    zip: "10001",
  });
  assert.equal(result2.valid, false);
  assert.ok(result2.errors.includes("GARBAGE_ADDRESS_DATA"));

  const result3 = validateAddress({
    street_address: "xxxxxx",
    city: "none",
    state: "FL",
    zip: "33101",
  });
  assert.equal(result3.valid, false);
  assert.ok(result3.errors.includes("GARBAGE_ADDRESS_DATA"));
});
