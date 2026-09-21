import { matchTreasurySdn, __setSdnSnapshotForTests } from "../ofac-treasury";

// Generate 10,000 synthetic SDN entries mimicking actual Treasury dataset
const entries = [];
const firstNames = ["JOHN", "MICHAEL", "VLADIMIR", "MOHAMMED", "ALEXANDER", "SERGEI", "CARLOS", "JOSE", "OSAMA", "DIMITRI"];
const lastNames = ["SMITH", "GARCIA", "IVANOV", "KHAN", "PETROV", "RODRIGUEZ", "LADEN", "PUTIN", "ALVAREZ", "KIM"];

for (let i = 0; i < 10000; i++) {
  const fn = firstNames[i % firstNames.length];
  const ln = lastNames[(i * 3) % lastNames.length];
  const mn = (i % 2 === 0) ? "Q." : "A.";
  entries.push({
    sdn_id: String(i + 1),
    name: `${fn} ${mn} ${ln}`,
    type: "individual",
    programs: ["SDGT"],
    akas: [
      `AKA ${fn} ${ln}`,
      `ALIAS ${ln} ${fn}`
    ]
  });
}

__setSdnSnapshotForTests({
  fetched_at: Date.now(),
  source: "benchmark",
  entries
});

async function runBenchmark() {
  const iterations = 1000;
  console.log(`Running OFAC Treasury benchmark with ${entries.length} SDN entries over ${iterations} queries...`);

  const queries = [
    { first_name: "John", last_name: "Public" }, // miss
    { first_name: "Vladimir", last_name: "Putin" }, // hit
    { first_name: "Mohammed", last_name: "Khan" }, // hit
    { first_name: "Jane", last_name: "Doe" }, // miss
    { first_name: "Carlos", last_name: "Rodriguez" }, // hit
  ];

  // Warmup
  for (let i = 0; i < 10; i++) {
    await matchTreasurySdn(queries[i % queries.length]!);
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await matchTreasurySdn(queries[i % queries.length]!);
  }
  const duration = performance.now() - start;

  console.log(`Total time for ${iterations} queries: ${duration.toFixed(2)}ms`);
  console.log(`Average time per query: ${(duration / iterations).toFixed(4)}ms`);
}

runBenchmark().catch(console.error);
