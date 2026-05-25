import { similarity, similarityName } from "./string-similarity.js";

const pairs = [
  ["Dr. Micah B. Edwin, MD", "Micah B Edwin"],
  ["John Smith Jr., DO", "John Smith"],
  ["Jane Doe, Esq.", "Jane Doe"],
  ["Micah Edwin", "Micah Edwin"],
];

const ITERATIONS = 100_000;

function benchmark() {
  console.log(`Running benchmark with ${ITERATIONS} iterations...`);

  // Benchmark similarity
  const startSim = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    for (const [a, b] of pairs) {
      similarity(a, b);
    }
  }
  const endSim = performance.now();
  console.log(`similarity: ${(endSim - startSim).toFixed(4)}ms total, ${((endSim - startSim) / (ITERATIONS * pairs.length)).toFixed(6)}ms per call`);

  // Benchmark similarityName
  const startSimName = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    for (const [a, b] of pairs) {
      similarityName(a, b);
    }
  }
  const endSimName = performance.now();
  console.log(`similarityName: ${(endSimName - startSimName).toFixed(4)}ms total, ${((endSimName - startSimName) / (ITERATIONS * pairs.length)).toFixed(6)}ms per call`);
}

benchmark();
