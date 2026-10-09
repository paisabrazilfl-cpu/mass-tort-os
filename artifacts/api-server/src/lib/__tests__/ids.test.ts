import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deepScan, scanValue } from "../ids";

describe("IDS Payload Scanner (deepScan & scanValue)", () => {
  test("detects SQL injection attacks", () => {
    assert.notEqual(scanValue("SELECT * FROM users WHERE 1=1"), null);
    assert.equal(scanValue("SELECT * FROM users WHERE 1=1")?.type, "sql_injection");
    assert.notEqual(scanValue("' OR '1'='1"), null);
    assert.equal(scanValue("' OR '1'='1")?.type, "sql_injection");
    assert.notEqual(scanValue("; DROP TABLE leads;"), null);
    assert.equal(scanValue("; DROP TABLE leads;")?.type, "sql_injection");
    assert.notEqual(scanValue("UNION ALL SELECT username, password FROM users"), null);
  });

  test("detects XSS attacks", () => {
    assert.notEqual(scanValue("<script>alert(1)</script>"), null);
    assert.equal(scanValue("<script>alert(1)</script>")?.type, "xss");
    assert.notEqual(scanValue("javascript:alert(1)"), null);
    assert.notEqual(scanValue("<img src=x onerror=alert(1)>"), null);
    assert.notEqual(scanValue("<iframe src='evt'></iframe>"), null);
  });

  test("detects path traversal attacks", () => {
    assert.notEqual(scanValue("../../../etc/passwd"), null);
    assert.equal(scanValue("../../../etc/passwd")?.type, "path_traversal");
    assert.notEqual(scanValue("..\\..\\windows\\system32"), null);
    assert.notEqual(scanValue("%2e%2e/etc/hosts"), null);
  });

  test("detects command injection attacks", () => {
    assert.notEqual(scanValue("; cat myfile.txt"), null);
    assert.equal(scanValue("; cat myfile.txt")?.type, "command_injection");
    assert.notEqual(scanValue("$(whoami)"), null);
    assert.notEqual(scanValue("${env:PATH}"), null);
  });

  test("allows clean payloads without false positives", () => {
    assert.equal(scanValue("John Doe"), null);
    assert.equal(scanValue("john.doe@example.com"), null);
    assert.equal(scanValue("555-0199"), null);
    assert.equal(scanValue("CA"), null);
    assert.equal(scanValue("a"), null);
    assert.equal(scanValue(""), null);
    assert.equal(scanValue("Client lived on base from 1980 to 1985."), null);

    const cleanPayload = {
      name: "Jane Smith",
      email: "jane@lawfirm.com",
      claim: {
        tort_id: "camp-lejeune",
        notes: "Exposed to contaminated water in 1982.",
      },
      tags: ["verified", "intake_complete"],
    };

    assert.equal(deepScan(cleanPayload), null);
  });

  test("deepScan traverses nested objects and arrays to find threats", () => {
    const maliciousPayload = {
      user: {
        profile: {
          bio: "Normal bio...",
          website: "<script>alert('xss')</script>",
        },
      },
    };

    const threat = deepScan(maliciousPayload);
    assert.notEqual(threat, null);
    assert.equal(threat?.type, "xss");
  });
});
