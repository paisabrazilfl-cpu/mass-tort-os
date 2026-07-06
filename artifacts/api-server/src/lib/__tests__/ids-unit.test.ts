
import { describe, it } from "node:test";
import assert from "node:assert";
import { scanValue, deepScan } from "../ids";

describe("IDS Scanning Logic", () => {
  it("should detect SQL injection", () => {
    const threat = scanValue("'; DROP TABLE users; --");
    assert.ok(threat);
    assert.strictEqual(threat.type, "sql_injection");
  });

  it("should detect XSS", () => {
    const threat = scanValue("<script>alert(1)</script>");
    assert.ok(threat);
    assert.strictEqual(threat.type, "xss");
  });

  it("should detect Path Traversal", () => {
    const threat = scanValue("../../../etc/passwd");
    assert.ok(threat);
    assert.strictEqual(threat.type, "path_traversal");
  });

  it("should detect Command Injection", () => {
    const threat = scanValue("; cat /etc/passwd");
    assert.ok(threat);
    assert.strictEqual(threat.type, "command_injection");
  });

  it("should not flag safe strings", () => {
    assert.strictEqual(scanValue("Hello, world!"), null);
    assert.strictEqual(scanValue("This is a normal sentence."), null);
  });

  it("should perform deep scanning of objects", () => {
    const obj = {
      nested: {
        danger: "<script>bad</script>"
      }
    };
    const threat = deepScan(obj);
    assert.ok(threat);
    assert.strictEqual(threat.type, "xss");
  });

  it("should perform deep scanning of arrays", () => {
    const arr = ["safe", "'; DROP TABLE; --"];
    const threat = deepScan(arr);
    assert.ok(threat);
    assert.strictEqual(threat.type, "sql_injection");
  });
});
