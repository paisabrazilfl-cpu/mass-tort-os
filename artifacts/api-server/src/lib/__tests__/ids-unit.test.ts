import { test } from "node:test";
import assert from "node:assert";
import { scanValue, deepScan } from "../ids.js";

test("scanValue: detects SQL injection", () => {
  const threat = scanValue("'; DROP TABLE users; --");
  assert.ok(threat);
  assert.strictEqual(threat.type, "sql_injection");
  assert.strictEqual(threat.severity, "critical");
});

test("scanValue: detects XSS", () => {
  const threat = scanValue("<script>alert(1)</script>");
  assert.ok(threat);
  assert.strictEqual(threat.type, "xss");
  assert.strictEqual(threat.severity, "high");
});

test("scanValue: detects path traversal", () => {
  const threat = scanValue("../../etc/passwd");
  assert.ok(threat);
  assert.strictEqual(threat.type, "path_traversal");
  assert.strictEqual(threat.severity, "high");
});

test("scanValue: detects command injection", () => {
  const threat = scanValue("; cat /etc/passwd");
  assert.ok(threat);
  assert.strictEqual(threat.type, "command_injection");
  assert.strictEqual(threat.severity, "critical");
});

test("scanValue: ignores safe values", () => {
  assert.strictEqual(scanValue("Hello world"), null);
  assert.strictEqual(scanValue("paralegal notes: Joe and wife both diagnosed"), null);
});

test("deepScan: scans objects recursively", () => {
  const obj = {
    nested: {
      key: "<script>alert(1)</script>"
    }
  };
  const threat = deepScan(obj);
  assert.ok(threat);
  assert.strictEqual(threat.type, "xss");
});

test("deepScan: scans arrays", () => {
  const arr = ["safe", "'; DROP TABLE users; --"];
  const threat = deepScan(arr);
  assert.ok(threat);
  assert.strictEqual(threat.type, "sql_injection");
});

test("deepScan: handles complex safe objects", () => {
  const obj = {
    user: {
      name: "John Doe",
      email: "john@example.com",
      bio: "Just a regular user sharing some notes about the case. Joe and wife both diagnosed with something normal.",
    },
    metadata: {
      page: 1,
      limit: 10,
      search: "active cases"
    },
    tags: ["legal", "medical", "notes"]
  };
  assert.strictEqual(deepScan(obj), null);
});
