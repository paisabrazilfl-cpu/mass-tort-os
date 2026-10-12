import { matchTreasurySdn, __setSdnSnapshotForTests } from "../ofac-treasury";

const entries = Array.from({ length: 10000 }, (_, i) => ({
  sdn_id: String(i),
  name: `FIRSTNAME${i} MIDDLENAME LASTNAME${i}`,
  type: "individual",
  programs: ["SDGT"],
  akas: [`ALIAS${i} OTHERNAME LASTNAME${i}`],
}));

__setSdnSnapshotForTests({ fetched_at: Date.now(), source: "test", entries });

async function runBenchmark() {
  // Warmup
  for (let i = 0; i < 10; i++) {
    await matchTreasurySdn({ first_name: "NONEXISTENT", last_name: "PERSON" });
  }

  const iterations = 500;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await matchTreasurySdn({
      first_name: `FIRSTNAME${i % 100}`,
      last_name: `LASTNAME${i % 100}`,
    });
  }
  const elapsed = performance.now() - start;
  const avgMs = elapsed / iterations;

  console.log(`[OFAC Treasury Benchmark]`);
  console.log(`Iterations: ${iterations}`);
  console.log(`Total time: ${elapsed.toFixed(2)} ms`);
  console.log(`Avg per query: ${avgMs.toFixed(4)} ms`);
}

runBenchmark().catch(console.error);
