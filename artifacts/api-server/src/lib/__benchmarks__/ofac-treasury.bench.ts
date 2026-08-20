import { matchTreasurySdn, __setSdnSnapshotForTests } from "../ofac-treasury";

// Create 10,000 synthetic SDN entries to reflect the size of Treasury's real sdn.csv (~10,000 entries + AKAs)
const mockEntries = Array.from({ length: 10000 }, (_, i) => ({
  sdn_id: `${i + 1}`,
  name: `SDN_NAME_PREFIX_${i} FIRST_${i % 500} MIDDLE_${i % 100} LAST_${i % 500} SUFFIX_${i}`,
  type: "individual",
  programs: ["SDNT", "SDGT"],
  akas: [
    `AKA1_PREFIX_${i} FIRST_${i % 500} LAST_${i % 500}`,
    `AKA2_PREFIX_${i} ALIAS_${i} NAME_${i}`,
  ],
}));

__setSdnSnapshotForTests({
  fetched_at: Date.now(),
  entries: mockEntries,
  source: "https://www.treasury.gov/ofac/downloads/sdn.csv",
});

const searchNames = [
  { first_name: "FIRST_250", last_name: "LAST_250" },
  { first_name: "NONEXISTENT_FIRST", last_name: "NONEXISTENT_LAST" },
  { first_name: "FIRST_499", last_name: "LAST_499" },
  { first_name: "ALIAS_100", last_name: "NAME_100" },
];

async function runBench() {
  const iterations = 50;
  console.log(`Running OFAC Treasury benchmark with 10,000 entries across ${iterations} queries...`);

  // Warmup
  for (const name of searchNames) {
    await matchTreasurySdn(name);
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    for (const name of searchNames) {
      await matchTreasurySdn(name);
    }
  }
  const end = performance.now();
  const totalCalls = iterations * searchNames.length;
  const totalTime = end - start;
  console.log(`Total time: ${totalTime.toFixed(4)}ms for ${totalCalls} queries`);
  console.log(`Avg time per query: ${(totalTime / totalCalls).toFixed(4)}ms`);
}

runBench().catch(console.error);
