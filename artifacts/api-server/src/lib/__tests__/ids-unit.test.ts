import { test } from "node:test";
import assert from "node:assert";
import { scanValue, deepScan } from "../ids";

test("IDS: scanValue detects SQL injection", () => {
  const threat = scanValue("SELECT * FROM users WHERE id = '1' OR '1'='1'");
  assert.ok(threat);
  assert.strictEqual(threat.type, "sql_injection");
});

test("IDS: scanValue detects XSS", () => {
  const threat = scanValue("<script>alert('xss')</script>");
  assert.ok(threat);
  assert.strictEqual(threat.type, "xss");
});

test("IDS: scanValue allows safe strings", () => {
  const threat = scanValue("Hello world, this is a safe string.");
  assert.strictEqual(threat, null);
});

test("IDS: deepScan scans objects recursively", () => {
  const payload = {
    user: {
      name: "Attacker",
      comment: "DROP TABLE users;--"
    }
  };
  const threat = deepScan(payload);
  assert.ok(threat);
  assert.strictEqual(threat.type, "sql_injection");
});

test("IDS: deepScan scans arrays", () => {
  const payload = ["safe", "<iframe src='evil.com'></iframe>"];
  const threat = deepScan(payload);
  assert.ok(threat);
  assert.strictEqual(threat.type, "xss");
});

test("IDS: deepScan handles null and non-objects", () => {
  assert.strictEqual(deepScan(null), null);
  assert.strictEqual(deepScan(123 as any), null);
});
