import { test } from "node:test";
import assert from "node:assert";
import { scanValue, deepScan } from "../ids";

test("scanValue detects SQL injection", () => {
  const payload = "UNION ALL SELECT password FROM users";
  const result = scanValue(payload);
  assert.strictEqual(result?.type, "sql_injection");
});

test("scanValue detects XSS", () => {
  const payload = "<script>alert(1)</script>";
  const result = scanValue(payload);
  assert.strictEqual(result?.type, "xss");
});

test("scanValue detects Path Traversal", () => {
  const payload = "../../../etc/passwd";
  const result = scanValue(payload);
  assert.strictEqual(result?.type, "path_traversal");
});

test("scanValue detects Command Injection", () => {
  const payload = "; cat /etc/passwd";
  const result = scanValue(payload);
  assert.strictEqual(result?.type, "command_injection");
});

test("scanValue returns null for safe input", () => {
  const payload = "Hello world, this is safe.";
  const result = scanValue(payload);
  assert.strictEqual(result, null);
});

test("deepScan handles objects", () => {
  const obj = {
    safe: "hello",
    dangerous: "SELECT * FROM users"
  };
  const result = deepScan(obj);
  assert.strictEqual(result?.type, "sql_injection");
});

test("deepScan handles arrays", () => {
  const arr = ["safe", "<script>alert(1)</script>"];
  const result = deepScan(arr);
  assert.strictEqual(result?.type, "xss");
});

test("deepScan handles nested structures", () => {
  const obj = {
    metadata: {
      tags: ["legal", "prose"],
      notes: {
        content: "Wait, drop table users;"
      }
    }
  };
  const result = deepScan(obj);
  assert.strictEqual(result?.type, "sql_injection");
});
