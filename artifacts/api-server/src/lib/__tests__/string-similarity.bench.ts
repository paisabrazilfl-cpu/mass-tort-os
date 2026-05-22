import { normalize, similarityName } from "../string-similarity";

const names1 = [
  "Dr. John Smith MD",
  "Jane Doe",
  "Robert Brown, Esq.",
  "Alice Johnson",
  "Michael Wilson II",
  "Dr. Sarah Davis",
  "William Taylor",
  "Elizabeth Thomas",
  "James Moore",
  "Linda Jackson"
];

const names2 = [
  "John Smith",
  "Jane A. Doe",
  "Robert Brown",
  "Alice B. Johnson",
  "Michael Wilson",
  "Sarah Davis",
  "Bill Taylor",
  "Liz Thomas",
  "Jim Moore",
  "Linda K. Jackson"
];

const ITERATIONS = 10000;

function runBenchmark() {
  const start = performance.now();

  for (let i = 0; i < ITERATIONS; i++) {
    for (let j = 0; j < names1.length; j++) {
      similarityName(names1[j], names2[j]);
    }
  }

  const end = performance.now();
  console.log(`Benchmark completed in ${(end - start).toFixed(2)}ms`);
  console.log(`Average time per similarityName call: ${((end - start) / (ITERATIONS * names1.length)).toFixed(4)}ms`);
}

runBenchmark();
