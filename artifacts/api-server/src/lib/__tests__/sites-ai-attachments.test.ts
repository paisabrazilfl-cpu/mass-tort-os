import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkUploadPolicy,
  checkAttachmentsPolicy,
  ALLOWED_UPLOAD_MIME,
  MAX_UPLOAD_BYTES,
} from "../sites-ai/attachments";

test("accepts allowed MIME types within the size cap", () => {
  for (const mime of ALLOWED_UPLOAD_MIME) {
    const r = checkUploadPolicy(mime, 1024);
    assert.equal(r.ok, true, `${mime} should be accepted`);
  }
});

test("accepts content-type with charset parameter", () => {
  const r = checkUploadPolicy("text/csv; charset=utf-8", 10);
  assert.equal(r.ok, true);
});

test("rejects disallowed MIME types", () => {
  for (const mime of ["application/x-msdownload", "application/zip", "video/mp4", ""]) {
    const r = checkUploadPolicy(mime, 10);
    assert.equal(r.ok, false, `${mime || "(empty)"} should be rejected`);
  }
});

test("rejects files over the size cap", () => {
  const r = checkUploadPolicy("application/pdf", MAX_UPLOAD_BYTES + 1);
  assert.equal(r.ok, false);
});

test("rejects negative / invalid size", () => {
  assert.equal(checkUploadPolicy("application/pdf", -1).ok, false);
  assert.equal(checkUploadPolicy("application/pdf", Number.NaN).ok, false);
});

test("checkAttachmentsPolicy returns first failure across a list", () => {
  const ok = checkAttachmentsPolicy([
    { contentType: "application/pdf", size: 100 },
    { contentType: "text/plain", size: 200 },
  ]);
  assert.equal(ok.ok, true);

  const bad = checkAttachmentsPolicy([
    { contentType: "application/pdf", size: 100 },
    { contentType: "application/zip", size: 200 },
  ]);
  assert.equal(bad.ok, false);
});
