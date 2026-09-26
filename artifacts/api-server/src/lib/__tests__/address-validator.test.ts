import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { validateAddress } from "../address-validator";

describe("address-validator", () => {
  test("valid address passes validation", () => {
    const res = validateAddress({
      street_address: "123 Main St",
      city: "Los Angeles",
      state: "CA",
      zip: "90001",
    });
    assert.strictEqual(res.valid, true);
    assert.deepStrictEqual(res.errors, []);
  });

  test("valid address with lowercase state and zip+4 passes validation", () => {
    const res = validateAddress({
      street_address: "456 Oak Ave",
      city: "New York",
      state: "ny",
      zip: "10001-1234",
    });
    assert.strictEqual(res.valid, true);
    assert.deepStrictEqual(res.errors, []);
  });

  test("missing fields returns appropriate error codes", () => {
    const res = validateAddress({});
    assert.strictEqual(res.valid, false);
    assert.deepStrictEqual(res.errors, [
      "MISSING_STREET",
      "MISSING_CITY",
      "MISSING_STATE",
      "MISSING_ZIP",
    ]);
  });

  test("invalid street, city, state, zip formats", () => {
    const res = validateAddress({
      street_address: "Main",
      city: "A",
      state: "CALIFORNIA",
      zip: "123",
    });
    assert.strictEqual(res.valid, false);
    assert.deepStrictEqual(res.errors, [
      "INVALID_STREET_FORMAT",
      "INVALID_CITY",
      "INVALID_STATE_CODE",
      "INVALID_ZIP_FORMAT",
    ]);
  });

  test("garbage address data detected", () => {
    const res1 = validateAddress({
      street_address: "test",
      city: "Los Angeles",
      state: "CA",
      zip: "90001",
    });
    assert.strictEqual(res1.valid, false);
    assert.ok(res1.errors.includes("GARBAGE_ADDRESS_DATA"));

    const res2 = validateAddress({
      street_address: "123 Main St",
      city: "na",
      state: "CA",
      zip: "90001",
    });
    assert.strictEqual(res2.valid, false);
    assert.ok(res2.errors.includes("GARBAGE_ADDRESS_DATA"));
  });
});
