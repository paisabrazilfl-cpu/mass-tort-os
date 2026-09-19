import assert from "node:assert/strict";
import test from "node:test";
import { deepScan, scanValue } from "../ids";

test("scanValue detects SQL injection patterns", () => {
  const sqli1 = scanValue("SELECT * FROM users WHERE '1'='1'");
  assert.ok(sqli1);
  assert.equal(sqli1?.type, "sql_injection");
  assert.equal(sqli1?.severity, "critical");

  const sqli2 = scanValue("admin' OR '1'='1");
  assert.ok(sqli2);
  assert.equal(sqli2?.type, "sql_injection");

  const sqli3 = scanValue("1; DROP TABLE leads; -- ");
  assert.ok(sqli3);
  assert.equal(sqli3?.type, "sql_injection");
});

test("scanValue detects XSS patterns", () => {
  const xss1 = scanValue("<script>alert('xss')</script>");
  assert.ok(xss1);
  assert.equal(xss1?.type, "xss");
  assert.equal(xss1?.severity, "high");

  const xss2 = scanValue("javascript:alert(1)");
  assert.ok(xss2);
  assert.equal(xss2?.type, "xss");

  const xss3 = scanValue("<img src=x onerror=alert(1)>");
  assert.ok(xss3);
  assert.equal(xss3?.type, "xss");
});

test("scanValue detects path traversal patterns", () => {
  const pt1 = scanValue("../../etc/passwd");
  assert.ok(pt1);
  assert.equal(pt1?.type, "path_traversal");
  assert.equal(pt1?.severity, "high");

  const pt2 = scanValue("%2e%2e%2f%2e%2e%2fetc%2fpasswd");
  assert.ok(pt2);
  assert.equal(pt2?.type, "path_traversal");
});

test("scanValue detects command injection patterns", () => {
  const ci1 = scanValue("123; whoami");
  assert.ok(ci1);
  assert.equal(ci1?.type, "command_injection");
  assert.equal(ci1?.severity, "critical");

  const ci2 = scanValue("$(whoami)");
  assert.ok(ci2);
  assert.equal(ci2?.type, "command_injection");
});

test("scanValue returns null for normal non-malicious text", () => {
  assert.equal(scanValue("Jane Doe"), null);
  assert.equal(scanValue("123 Main Street"), null);
  assert.equal(scanValue("jane@example.com"), null);
  assert.equal(scanValue("Roundup litigation"), null);
  assert.equal(scanValue(""), null);
  assert.equal(scanValue("a"), null);
});

test("deepScan traverses nested objects and arrays", () => {
  const cleanObj = {
    user: { name: "Alice", email: "alice@example.com" },
    tags: ["web", "lead"],
  };
  assert.equal(deepScan(cleanObj), null);

  const maliciousObj = {
    user: { name: "Alice", details: "<script>alert(1)</script>" },
    tags: ["web", "lead"],
  };
  const threat = deepScan(maliciousObj);
  assert.ok(threat);
  assert.equal(threat?.type, "xss");

  const maliciousArray = {
    items: ["normal", "../../etc/passwd"],
  };
  const threat2 = deepScan(maliciousArray);
  assert.ok(threat2);
  assert.equal(threat2?.type, "path_traversal");
});
