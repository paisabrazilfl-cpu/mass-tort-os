import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateAddress } from "../address-validator";

describe("address-validator", () => {
  test("validates clean US address", () => {
    const res = validateAddress({
      street_address: "123 Main St",
      city: "New York",
      state: "NY",
      zip: "10001",
    });
    assert.equal(res.valid, true);
    assert.deepEqual(res.errors, []);
  });

  test("handles lowercase state codes", () => {
    const res = validateAddress({
      street_address: "456 Market St",
      city: "San Francisco",
      state: "ca",
      zip: "94105-1234",
    });
    assert.equal(res.valid, true);
    assert.deepEqual(res.errors, []);
  });

  test("catches missing and invalid fields", () => {
    const res = validateAddress({
      street_address: "invalid",
      city: "x",
      state: "XX",
      zip: "abc",
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.includes("INVALID_STREET_FORMAT"));
    assert.ok(res.errors.includes("INVALID_CITY"));
    assert.ok(res.errors.includes("INVALID_STATE_CODE"));
    assert.ok(res.errors.includes("INVALID_ZIP_FORMAT"));
  });

  test("catches garbage data in address fields", () => {
    const res = validateAddress({
      street_address: "asdf",
      city: "test",
      state: "NY",
      zip: "10001",
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.includes("GARBAGE_ADDRESS_DATA"));
  });

  test("catches missing fields", () => {
    const res = validateAddress({});
    assert.equal(res.valid, false);
    assert.ok(res.errors.includes("MISSING_STREET"));
    assert.ok(res.errors.includes("MISSING_CITY"));
    assert.ok(res.errors.includes("MISSING_STATE"));
    assert.ok(res.errors.includes("MISSING_ZIP"));
  });
});
