import test from "node:test";
import assert from "node:assert/strict";
import { scanValue, deepScan } from "../ids";

test("IDS scanning logic: scanValue", async (t) => {
  await t.test("detects SQL injection", () => {
    assert.ok(scanValue("SELECT * FROM users"));
    assert.ok(scanValue("' OR '1'='1"));
    assert.ok(scanValue("--; DROP TABLE users"));
    assert.ok(scanValue("UNION ALL SELECT NULL"));
  });

  await t.test("detects XSS", () => {
    assert.ok(scanValue("<script>alert(1)</script>"));
    assert.ok(scanValue("javascript:alert(1)"));
    assert.ok(scanValue("<img src=x onerror=alert(1)>"));
    assert.ok(scanValue("document.cookie"));
  });

  await t.test("detects path traversal", () => {
    assert.ok(scanValue("../../../etc/passwd"));
    assert.ok(scanValue("..\\..\\windows\\win.ini"));
    assert.ok(scanValue("/etc/shadow"));
  });

  await t.test("detects command injection", () => {
    assert.ok(scanValue("; cat /etc/passwd"));
    assert.ok(scanValue("`id`"));
    assert.ok(scanValue("$(whoami)"));
  });

  await t.test("ignores safe strings", () => {
    assert.strictEqual(scanValue("Just a normal sentence."), null);
    assert.strictEqual(scanValue("Joe and wife both diagnosed"), null); // FP check
    assert.strictEqual(scanValue("Contact us at support@example.com"), null);
    assert.strictEqual(scanValue("https://example.com/page?id=123"), null);
  });
});

test("IDS scanning logic: deepScan", async (t) => {
  await t.test("detects threat in nested object", () => {
    const payload = {
      user: {
        name: "John",
        bio: "I like to <script>alert('XSS')</script>"
      }
    };
    assert.ok(deepScan(payload));
  });

  await t.test("detects threat in array", () => {
    const payload = {
      tags: ["safe", "also-safe", "'; DROP TABLE users"]
    };
    assert.ok(deepScan(payload));
  });

  await t.test("ignores safe nested object", () => {
    const payload = {
      order: {
        id: 123,
        items: [
          { name: "Widget", price: 10 },
          { name: "Gadget", price: 20 }
        ]
      }
    };
    assert.strictEqual(deepScan(payload), null);
  });
});
