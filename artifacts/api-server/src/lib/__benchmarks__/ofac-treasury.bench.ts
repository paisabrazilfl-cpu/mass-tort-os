import { matchTreasurySdn, __setSdnSnapshotForTests } from "../ofac-treasury";

// Build a synthetic SDN list with 10,000 entries and 5,000 AKAs
const entries = Array.from({ length: 10000 }, (_, i) => ({
  sdn_id: String(i),
  name: i === 9999 ? "JOHN Q. PUBLIC" : `INDIVIDUAL SPECIMEN NUMBER ${i}`,
  type: "individual",
  programs: ["SDGT"],
  akas: i % 2 === 0 ? [`ALIAS NAME ${i}`] : [],
}));

__setSdnSnapshotForTests({
  fetched_at: Date.now(),
  source: "benchmark",
  entries,
});

async function runBenchmark() {
  const iterations = 1000;
  console.log(`Running matchTreasurySdn benchmark across ${entries.length} entries for ${iterations} iterations...`);

  // Warmup
  await matchTreasurySdn({ first_name: "John", last_name: "Public" });

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await matchTreasurySdn({ first_name: "John", last_name: "Public" });
  }
  const end = performance.now();

  const totalMs = end - start;
  const avgMs = totalMs / iterations;
  console.log(`matchTreasurySdn: ${totalMs.toFixed(2)}ms total, ${avgMs.toFixed(4)}ms per lookup (${(1000 / avgMs).toFixed(0)} ops/sec)`);
}

runBenchmark().catch(console.error);
