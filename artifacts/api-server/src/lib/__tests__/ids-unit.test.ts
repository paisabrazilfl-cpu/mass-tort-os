import { test } from "node:test";
import assert from "node:assert";
import { scanValue, deepScan } from "../ids";

test("IDS: scanValue detects SQL injection", () => {
  const threat = scanValue("select * from users;");
  assert.ok(threat);
  assert.strictEqual(threat.type, "sql_injection");
  assert.strictEqual(threat.severity, "critical");
});

test("IDS: scanValue detects XSS", () => {
  const threat = scanValue("<script>alert(1)</script>");
  assert.ok(threat);
  assert.strictEqual(threat.type, "xss");
  assert.strictEqual(threat.severity, "high");
});

test("IDS: scanValue detects Path Traversal", () => {
  const threat = scanValue("../../../etc/passwd");
  assert.ok(threat);
  assert.strictEqual(threat.type, "path_traversal");
  assert.strictEqual(threat.severity, "high");
});

test("IDS: scanValue detects Command Injection", () => {
  const threat = scanValue("; ls -la");
  assert.ok(threat);
  assert.strictEqual(threat.type, "command_injection");
  assert.strictEqual(threat.severity, "critical");
});

test("IDS: scanValue returns null for safe strings", () => {
  const threat = scanValue("Hello, world!");
  assert.strictEqual(threat, null);
});

test("IDS: deepScan traverses objects and arrays", () => {
  const payload = {
    user: "legit_user",
    meta: {
      bio: "I like SQL, but not injection",
      nested: [
        "safe",
        "DROP TABLE leads;"
      ]
    }
  };
  const threat = deepScan(payload);
  assert.ok(threat);
  assert.strictEqual(threat.type, "sql_injection");
});

test("IDS: scanValue prioritizes SQL over XSS", () => {
  // A payload containing both SQL injection and XSS
  const payload = "select * from users; <script>alert(1)</script>";
  const threat = scanValue(payload);
  assert.ok(threat);
  // Based on the updated scanValue, SQL is checked first
  assert.strictEqual(threat.type, "sql_injection");
});
