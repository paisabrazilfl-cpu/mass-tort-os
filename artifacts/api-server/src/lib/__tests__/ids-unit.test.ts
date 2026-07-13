import test from "node:test";
import assert from "node:assert";
import { __test_ids } from "../ids";

const { scanValue, deepScan } = __test_ids;

test("scanValue detects SQL injection", () => {
  const threat = scanValue("'; DROP TABLE leads; --");
  assert.ok(threat);
  assert.strictEqual(threat?.type, "sql_injection");
  assert.strictEqual(threat?.severity, "critical");
});

test("scanValue detects XSS", () => {
  const threat = scanValue("<script>alert(1)</script>");
  assert.ok(threat);
  assert.strictEqual(threat?.type, "xss");
  assert.strictEqual(threat?.severity, "high");
});

test("scanValue detects path traversal", () => {
  const threat = scanValue("../../../etc/passwd");
  assert.ok(threat);
  assert.strictEqual(threat?.type, "path_traversal");
  assert.strictEqual(threat?.severity, "high");
});

test("scanValue detects command injection", () => {
  const threat = scanValue("; ls -la");
  assert.ok(threat);
  assert.strictEqual(threat?.type, "command_injection");
  assert.strictEqual(threat?.severity, "critical");
});

test("scanValue returns null for safe strings", () => {
  assert.strictEqual(scanValue("Hello, world!"), null);
  assert.strictEqual(scanValue("Joe AND wife both diagnosed = severe"), null);
});

test("deepScan detects threats in objects", () => {
  const obj = {
    user: {
      name: "John",
      bio: "<script>alert('xss')</script>"
    }
  };
  const threat = deepScan(obj);
  assert.ok(threat);
  assert.strictEqual(threat?.type, "xss");
});

test("deepScan detects threats in arrays", () => {
  const obj = ["safe", "'; DROP TABLE users; --"];
  const threat = deepScan(obj);
  assert.ok(threat);
  assert.strictEqual(threat?.type, "sql_injection");
});
