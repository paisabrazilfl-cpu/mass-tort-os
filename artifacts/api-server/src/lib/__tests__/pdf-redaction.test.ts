/**
 * Defect #8 lock-in: pdf-redaction must NEVER silently no-op a redaction
 * request. Prior to the fix, `redactPdf` only handled `type: "region"` rules
 * and silently dropped `type: "text"` rules, returning the PDF unchanged.
 *
 * The dead `createHipaaRedactedPdf` helper compounded the dishonesty: it had
 * a name that promised PHI redaction but produced an unredacted document
 * because all its rules were `type: "text"`.
 *
 * Honest contract today:
 *   - region rules: drawn as opaque black rectangles.
 *   - text rules:   THROW with a clear "not implemented" error so a caller
 *                   that thinks redaction occurred is told otherwise.
 *
 * pdf-lib does not expose a per-glyph text-extraction API needed to locate
 * regex matches, so text-pattern redaction will require a different toolchain
 * (see follow-up). Until then the API refuses to pretend.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactPdf, createBlankPdfWithText, RedactionNotImplementedError } from "../pdf-redaction.js";

test("redactPdf with region rule mutates the PDF (smoke)", async () => {
  const original = await createBlankPdfWithText("Hello world", "Smoke");
  const redacted = await redactPdf(Buffer.from(original), [
    { type: "region", page: 0, x: 50, y: 600, width: 100, height: 20, label: "PII" },
  ]);
  // The drawn rectangle pushes new content into the page stream — bytes change.
  assert.notEqual(
    Buffer.from(redacted).toString("base64"),
    Buffer.from(original).toString("base64"),
    "region redaction must alter the PDF content stream",
  );
});

test("redactPdf with text rule throws a clear not-implemented error", async () => {
  const original = await createBlankPdfWithText("SSN 123-45-6789", "PHI");
  await assert.rejects(
    () =>
      redactPdf(Buffer.from(original), [
        { type: "text", pattern: "\\d{3}-\\d{2}-\\d{4}", label: "REDACTED-SSN" },
      ]),
    /text-pattern redaction is not implemented/i,
    "text rules must fail loudly, not silently no-op",
  );
});

test("createHipaaRedactedPdf has been removed (was dishonest dead code)", async () => {
  const mod = await import("../pdf-redaction.js");
  assert.equal(
    (mod as Record<string, unknown>).createHipaaRedactedPdf,
    undefined,
    "createHipaaRedactedPdf used to claim to redact PHI but produced an unredacted PDF — must not exist",
  );
});

test("redactPdf with mixed region+text rules fails atomically (no partial redaction)", async () => {
  // Architect-flagged honesty case: a mixed batch must NEVER apply the
  // valid region rule, succeed, and silently drop the text rule. The
  // pre-flight runs before the PDF is mutated, so the throw guarantees
  // the caller knows redaction did not happen at all.
  const original = await createBlankPdfWithText("Hello world", "Mixed");
  await assert.rejects(
    () =>
      redactPdf(Buffer.from(original), [
        { type: "region", page: 0, x: 50, y: 600, width: 100, height: 20, label: "PII" },
        { type: "text", pattern: "\\d{3}-\\d{2}-\\d{4}", label: "REDACTED-SSN" },
      ]),
    (err: unknown) => err instanceof RedactionNotImplementedError && /text-pattern redaction is not implemented/i.test(err.message),
    "mixed rules must reject atomically with the typed not-implemented error",
  );
});

test("redactPdf with malformed region rule throws (no silent default-to-page-origin redaction)", async () => {
  // The pre-fix code defaulted missing x/y/width/height to (0,0,100,20)
  // and silently skipped the rule entirely if `page` was missing — both
  // paths produced an unredacted-but-200-OK result that lied to callers.
  // Now both shapes throw the same typed error.
  const original = await createBlankPdfWithText("Hello world", "Bad-region");
  // Missing page
  await assert.rejects(
    () => redactPdf(Buffer.from(original), [{ type: "region", x: 50, y: 600, width: 100, height: 20 }]),
    (err: unknown) => err instanceof RedactionNotImplementedError && /region redaction rules must include page, x, y, width, and height/i.test(err.message),
    "region rule with no page must reject",
  );
  // Missing coords
  await assert.rejects(
    () => redactPdf(Buffer.from(original), [{ type: "region", page: 0 }]),
    (err: unknown) => err instanceof RedactionNotImplementedError && /region redaction rules must include page, x, y, width, and height/i.test(err.message),
    "region rule with no coords must reject",
  );
});

test("RedactionNotImplementedError carries a stable error code for route mapping", () => {
  // Routes match on `instanceof RedactionNotImplementedError` and surface
  // err.code in the API envelope. Guard against accidental rename of the
  // code string — that would silently break the CRM client's branching.
  const err = new RedactionNotImplementedError("anything");
  assert.equal(err.code, "redaction_not_implemented");
  assert.equal(err.name, "RedactionNotImplementedError");
});
