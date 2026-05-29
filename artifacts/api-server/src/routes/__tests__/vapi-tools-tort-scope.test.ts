/**
 * Conflict-resolution tests for the per-tort Vapi tool callbacks (Task #90).
 *
 * Per-tort agents bake a `?tort=<id>` hint into each tool's server URL. That
 * hint is AUTHORITATIVE — the model cannot widen its own scope by sending a
 * different tort_type in the body. These tests pin that behavior so future
 * drift fails CI instead of silently allowing cross-tort access.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { resolveTortType } from "../vapi-tools";

function fakeReq(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

describe("resolveTortType — tort scope conflict resolution", () => {
  it("URL hint is authoritative when body omits tort", () => {
    const out = resolveTortType(fakeReq({ tort: "roundup" }), undefined);
    assert.deepEqual(out, { ok: true, tort: "roundup" });
  });

  it("URL hint wins when body agrees", () => {
    const out = resolveTortType(fakeReq({ tort: "roundup" }), "roundup");
    assert.deepEqual(out, { ok: true, tort: "roundup" });
  });

  it("rejects when body tort conflicts with URL hint", () => {
    const out = resolveTortType(fakeReq({ tort: "roundup" }), "camp_lejeune");
    assert.deepEqual(out, { ok: false, code: "BAD_TORT_SCOPE" });
  });

  it('treats body "unknown" as absent (no false BAD_TORT_SCOPE)', () => {
    const out = resolveTortType(fakeReq({ tort: "roundup" }), "unknown");
    assert.deepEqual(out, { ok: true, tort: "roundup" });
  });

  it('treats body "UNKNOWN" (any case) as absent', () => {
    const out = resolveTortType(fakeReq({ tort: "roundup" }), "UNKNOWN");
    assert.deepEqual(out, { ok: true, tort: "roundup" });
  });

  it("falls back to body tort when no URL hint (legacy generic assistant)", () => {
    const out = resolveTortType(fakeReq({}), "talcum");
    assert.deepEqual(out, { ok: true, tort: "talcum" });
  });

  it('defaults to "unknown" when neither URL nor body supplies a tort', () => {
    const out = resolveTortType(fakeReq({}), undefined);
    assert.deepEqual(out, { ok: true, tort: "unknown" });
  });

  it("trims whitespace on both channels before comparing", () => {
    const out = resolveTortType(fakeReq({ tort: "  roundup  " }), "  roundup  ");
    assert.deepEqual(out, { ok: true, tort: "roundup" });
  });
});
