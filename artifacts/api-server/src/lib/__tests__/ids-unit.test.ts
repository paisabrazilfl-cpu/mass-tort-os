import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scanValue, deepScan } from "../ids";

describe("IDS Unit Tests", () => {
  test("scanValue detects SQL injection", () => {
    const malicious = "SELECT * FROM users WHERE '1'='1'";
    const result = scanValue(malicious);
    assert.ok(result);
    assert.equal(result?.type, "sql_injection");
  });

  test("scanValue detects XSS", () => {
    const malicious = "<script>alert('xss')</script>";
    const result = scanValue(malicious);
    assert.ok(result);
    assert.equal(result?.type, "xss");
  });

  test("scanValue detects path traversal", () => {
    const malicious = "../../../etc/passwd";
    const result = scanValue(malicious);
    assert.ok(result);
    assert.equal(result?.type, "path_traversal");
  });

  test("scanValue detects command injection", () => {
    const malicious = "; cat /etc/passwd";
    const result = scanValue(malicious);
    assert.ok(result);
    assert.equal(result?.type, "command_injection");
  });

  test("scanValue returns null for safe strings", () => {
    const safe = "Just a normal string with no threats.";
    const result = scanValue(safe);
    assert.equal(result, null);
  });

  test("deepScan traverses objects", () => {
    const obj = {
      nested: {
        danger: "DROP TABLE users"
      }
    };
    const result = deepScan(obj);
    assert.ok(result);
    assert.equal(result?.type, "sql_injection");
  });

  test("deepScan traverses arrays", () => {
    const arr = ["safe", "also safe", "javascript:alert(1)"];
    const result = deepScan(arr);
    assert.ok(result);
    assert.equal(result?.type, "xss");
  });

  test("deepScan handles null and non-objects", () => {
    assert.equal(deepScan(null), null);
    assert.equal(deepScan(123), null);
    assert.equal(deepScan(true), null);
  });
});
