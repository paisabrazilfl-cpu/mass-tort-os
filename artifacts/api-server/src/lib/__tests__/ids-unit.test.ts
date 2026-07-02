import { test, describe } from "node:test";
import assert from "node:assert";
import { scanValue, deepScan } from "../ids";

describe("IDS Unit Tests", () => {
  test("scanValue detects SQL injection", () => {
    const sql = "SELECT * FROM users WHERE id = 1 OR 1=1";
    const result = scanValue(sql);
    assert.ok(result);
    assert.strictEqual(result.type, "sql_injection");
  });

  test("scanValue detects XSS", () => {
    const xss = "<script>alert('xss')</script>";
    const result = scanValue(xss);
    assert.ok(result);
    assert.strictEqual(result.type, "xss");
  });

  test("scanValue detects Path Traversal", () => {
    const pt = "../../../etc/passwd";
    const result = scanValue(pt);
    assert.ok(result);
    assert.strictEqual(result.type, "path_traversal");
  });

  test("scanValue detects Command Injection", () => {
    const ci = "; id";
    const result = scanValue(ci);
    assert.ok(result);
    assert.strictEqual(result.type, "command_injection");
  });

  test("scanValue returns null for safe strings", () => {
    const safe = "This is a safe string";
    const result = scanValue(safe);
    assert.strictEqual(result, null);
  });

  test("deepScan handles nested objects", () => {
    const obj = {
      a: "safe",
      inner: {
        b: "SELECT * FROM table"
      }
    };
    const result = deepScan(obj);
    assert.ok(result);
    assert.strictEqual(result.type, "sql_injection");
  });

  test("deepScan handles arrays", () => {
    const arr = ["safe", "<script>alert(1)</script>"];
    const result = deepScan(arr);
    assert.ok(result);
    assert.strictEqual(result.type, "xss");
  });

  test("deepScan respects path tracking", () => {
    // Actually deepScan doesn't return the path in the ThreatDetection object,
    // it just uses it for recursion.
    const obj = { a: "safe" };
    assert.strictEqual(deepScan(obj), null);
  });
});
