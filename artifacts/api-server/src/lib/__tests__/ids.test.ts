import assert from "node:assert";
import { test, describe } from "node:test";
import { scanValue, deepScan } from "../ids";

describe("IDS Intrusion Detection", () => {
  describe("scanValue", () => {
    test("returns null for clean strings", () => {
      assert.strictEqual(scanValue(""), null);
      assert.strictEqual(scanValue("a"), null);
      assert.strictEqual(scanValue("John Smith"), null);
      assert.strictEqual(scanValue("john.smith@example.com"), null);
      assert.strictEqual(scanValue("555-123-4567"), null);
      assert.strictEqual(
        scanValue("Claimant was diagnosed in 2021 following exposure at work."),
        null
      );
      assert.strictEqual(
        scanValue("Joe AND wife both diagnosed = severe"),
        null
      );
    });

    test("detects SQL injection", () => {
      assert.strictEqual(
        scanValue("SELECT * FROM users WHERE 1=1")?.type,
        "sql_injection"
      );
      assert.strictEqual(
        scanValue("' or 1=1 --")?.type,
        "sql_injection"
      );
      assert.strictEqual(
        scanValue("UNION ALL SELECT 1, 2, 3")?.type,
        "sql_injection"
      );
      assert.strictEqual(
        scanValue("/* comment */ DROP TABLE leads;")?.type,
        "sql_injection"
      );
    });

    test("detects XSS", () => {
      assert.strictEqual(
        scanValue("<script>alert('xss')</script>")?.type,
        "xss"
      );
      assert.strictEqual(
        scanValue("javascript:alert(1)")?.type,
        "xss"
      );
      assert.strictEqual(
        scanValue("<img src=x onerror=alert(1)>")?.type,
        "xss"
      );
    });

    test("detects Path Traversal", () => {
      assert.strictEqual(
        scanValue("../../etc/passwd")?.type,
        "path_traversal"
      );
      assert.strictEqual(
        scanValue("%2e%2e/etc/hosts")?.type,
        "path_traversal"
      );
      assert.strictEqual(
        scanValue("/proc/self/status")?.type,
        "path_traversal"
      );
    });

    test("detects Command Injection", () => {
      assert.strictEqual(
        scanValue("; whoami")?.type,
        "command_injection"
      );
      assert.strictEqual(
        scanValue("$(whoami)")?.type,
        "command_injection"
      );
      assert.strictEqual(
        scanValue("${USER}")?.type,
        "command_injection"
      );
    });
  });

  describe("deepScan", () => {
    test("scans nested objects and arrays", () => {
      const cleanObj = {
        name: "John",
        emails: ["john@example.com", "j.smith@example.com"],
        address: {
          street: "123 Main St",
          city: "New York",
        },
      };
      assert.strictEqual(deepScan(cleanObj), null);

      const maliciousObj = {
        name: "John",
        emails: ["john@example.com", "SELECT * FROM users WHERE 1=1"],
      };
      const threat = deepScan(maliciousObj);
      assert.ok(threat !== null);
      assert.strictEqual(threat?.type, "sql_injection");
    });
  });
});
