import { levenshtein, similarity, similarityName, normalize, normalizeName } from "../string-similarity";

const a = "Dr. Micah Edwin, MD";
const b = "Micah Edwin";

const cleanA = "micah edwin";
const cleanB = "micah edwin";

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

console.log("\n--- Noisy Inputs (with titles/credentials) ---");
benchmark("levenshtein (noisy)", () => {
  levenshtein(a, b);
});

benchmark("normalize (noisy)", () => {
  normalize(a);
});

benchmark("normalizeName (noisy)", () => {
  normalizeName(a);
});

benchmark("similarity (noisy)", () => {
  similarity(a, b);
});

benchmark("similarityName (noisy)", () => {
  similarityName(a, b);
});

console.log("\n--- Clean Inputs (pre-normalized, no titles/credentials) ---");
benchmark("levenshtein (clean)", () => {
  levenshtein(cleanA, cleanB);
});

benchmark("normalize (clean)", () => {
  normalize(cleanA);
});

benchmark("normalizeName (clean)", () => {
  normalizeName(cleanA);
});

benchmark("similarity (clean)", () => {
  similarity(cleanA, cleanB);
});

benchmark("similarityName (clean)", () => {
  similarityName(cleanA, cleanB);
});
