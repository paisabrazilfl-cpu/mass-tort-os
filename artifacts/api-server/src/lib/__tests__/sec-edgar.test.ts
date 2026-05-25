// Tests for the SEC EDGAR business-entity adapter. Network is not hit
// — we inject a synthetic snapshot via the test helper so the
// normalization + lookup behavior is pinned independently of any
// real-world API drift.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { searchEdgar, __setEdgarSnapshotForTests } from "../bg-hub/sec-edgar";

after(() => __setEdgarSnapshotForTests(null));

function snapshotWith(entries: Array<{ cik: number; ticker: string; title: string }>) {
  const byTitle = new Map<string, Array<{ cik: number; ticker: string; title: string }>>();
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,;()\[\]"']/g, " ")
      .replace(/\b(inc|incorporated|corp|corporation|llc|l\.l\.c|ltd|limited|co|company|plc|nv|sa|ag|holding|holdings|group|trust|partners|lp|llp)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  for (const e of entries) {
    const key = normalize(e.title);
    if (!key) continue;
    const arr = byTitle.get(key) ?? [];
    arr.push(e);
    byTitle.set(key, arr);
  }
  __setEdgarSnapshotForTests({ fetched_at: Date.now(), byTitle, count: entries.length });
}

describe("searchEdgar", () => {
  test("matches an exact-name registered company", async () => {
    snapshotWith([{ cik: 320193, ticker: "AAPL", title: "Apple Inc." }]);
    const r = await searchEdgar("Apple Inc.");
    assert.equal(r.status, "ok");
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0]!.cik, 320193);
    assert.equal(r.matches[0]!.ticker, "AAPL");
    assert.ok(r.matches[0]!.edgar_url.includes("CIK=0000320193"));
  });

  test("normalizes corporate suffixes so 'Apple Inc' matches 'APPLE'", async () => {
    snapshotWith([{ cik: 1, ticker: "X", title: "APPLE" }]);
    const r = await searchEdgar("Apple, Inc.");
    assert.equal(r.matches.length, 1);
  });

  test("returns empty matches for unknown businesses", async () => {
    snapshotWith([{ cik: 1, ticker: "X", title: "Acme Corp" }]);
    const r = await searchEdgar("Totally Made Up LLC");
    assert.equal(r.status, "ok");
    assert.deepEqual(r.matches, []);
  });

  test("returns error envelope with missing businessName", async () => {
    snapshotWith([]);
    const r = await searchEdgar("");
    assert.equal(r.status, "error");
    assert.equal(r.matches.length, 0);
  });

  test("caps matches at 5 even with N name-collisions", async () => {
    snapshotWith(
      Array.from({ length: 10 }, (_, i) => ({
        cik: i + 1,
        ticker: `T${i}`,
        title: "Shared Name",
      })),
    );
    const r = await searchEdgar("Shared Name");
    assert.equal(r.matches.length, 5);
  });

  test("EDGAR URL is the standard browse-edgar getcompany format with zero-padded CIK", async () => {
    snapshotWith([{ cik: 7, ticker: "X", title: "Small Co" }]);
    const r = await searchEdgar("Small Co");
    assert.equal(r.matches.length, 1);
    assert.ok(r.matches[0]!.edgar_url.includes("CIK=0000000007"));
    assert.ok(r.matches[0]!.edgar_url.includes("action=getcompany"));
  });
});
