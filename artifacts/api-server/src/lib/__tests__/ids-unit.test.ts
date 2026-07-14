import { test, describe } from "node:test";
import assert from "node:assert";
import { scanValue, deepScan } from "../ids";

describe("ids: scanValue", () => {
  test("returns null for safe values", () => {
    assert.strictEqual(scanValue("hello world"), null);
    assert.strictEqual(scanValue("select the items"), null); // not a full injection pattern
  });

  test("detects SQL injection", () => {
    const result = scanValue("SELECT * FROM users; DROP TABLE students;");
    assert.ok(result);
    assert.strictEqual(result.type, "sql_injection");
    assert.strictEqual(result.severity, "critical");
  });

  test("detects XSS", () => {
    const result = scanValue("<script>alert(1)</script>");
    assert.ok(result);
    assert.strictEqual(result.type, "xss");
    assert.strictEqual(result.severity, "high");
  });

  test("detects path traversal", () => {
    const result = scanValue("../../../etc/passwd");
    assert.ok(result);
    assert.strictEqual(result.type, "path_traversal");
    assert.strictEqual(result.severity, "high");
  });

  test("detects command injection", () => {
    const result = scanValue("; cat /etc/passwd");
    assert.ok(result);
    assert.strictEqual(result.type, "command_injection");
    assert.strictEqual(result.severity, "critical");
  });
});

describe("ids: deepScan", () => {
  test("scans nested objects", () => {
    const obj = {
      user: {
        name: "safe",
        bio: "<script>bad</script>"
      }
    };
    const result = deepScan(obj);
    assert.ok(result);
    assert.strictEqual(result.type, "xss");
  });

  test("scans arrays", () => {
    const arr = ["safe", "DROP TABLE users"];
    // Wait, "DROP TABLE users" alone might not match our hardened SQL pattern
    const result = deepScan(["safe", "UNION ALL SELECT password FROM users"]);
    assert.ok(result);
    assert.strictEqual(result.type, "sql_injection");
  });
});
