import { test } from "node:test";
import assert from "node:assert";
import { scanValue, deepScan } from "../ids";

test("scanValue detects SQL injection", () => {
  const threat = scanValue("SELECT * FROM users WHERE id = '1' OR '1'='1'--");
  assert.strictEqual(threat?.type, "sql_injection");
  assert.strictEqual(threat?.severity, "critical");
});

test("scanValue detects XSS", () => {
  const threat = scanValue("<script>alert('xss');</script>");
  assert.strictEqual(threat?.type, "xss");
  assert.strictEqual(threat?.severity, "high");
});

test("scanValue detects Path Traversal", () => {
  const threat = scanValue("../../../../etc/passwd");
  assert.strictEqual(threat?.type, "path_traversal");
  assert.strictEqual(threat?.severity, "high");
});

test("scanValue detects Command Injection", () => {
  const threat = scanValue("; cat /etc/passwd");
  assert.strictEqual(threat?.type, "command_injection");
  assert.strictEqual(threat?.severity, "critical");
});

test("scanValue returns null for safe input", () => {
  const threat = scanValue("Just a regular string with no threats.");
  assert.strictEqual(threat, null);
});

test("deepScan traverses objects", () => {
  const threat = deepScan({
    user: {
      bio: "<script>alert('xss');</script>"
    }
  });
  assert.strictEqual(threat?.type, "xss");
});

test("deepScan traverses arrays", () => {
  const threat = deepScan({
    items: ["safe", "SELECT * FROM users"]
  });
  assert.strictEqual(threat?.type, "sql_injection");
});
