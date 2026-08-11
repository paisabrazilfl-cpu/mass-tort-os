import { levenshtein, similarity, similarityName, normalize, normalizeName } from "../string-similarity";

const a = "Dr. Micah Edwin, MD";
const b = "Micah Edwin";

const cleanA = "micah edwin";
const cleanB = "micah smith";

const iterations = 100000;

console.log(`Running benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

console.log("\n=== Original Benchmark (Complex strings with titles/credentials) ===");
benchmark("levenshtein", () => {
  levenshtein(a, b);
});

benchmark("normalize", () => {
  normalize(a);
});

benchmark("normalizeName", () => {
  normalizeName(a);
});

benchmark("similarity", () => {
  similarity(a, b);
});

benchmark("similarityName", () => {
  similarityName(a, b);
});

console.log("\n=== Fast Path Benchmark (Clean, pre-normalized, title-free strings) ===");
benchmark("normalize (clean)", () => {
  normalize(cleanA);
});

benchmark("normalizeName (clean)", () => {
  normalizeName(cleanA);
});

benchmark("similarityName (clean)", () => {
  similarityName(cleanA, cleanB);
});
