import { levenshtein, similarity, similarityName, normalize, normalizeName } from "../string-similarity";

const a = "Dr. Micah Edwin, MD";
const b = "Micah Edwin";

const cleanA = "micah edwin";
const cleanB = "john smith";

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

console.log("\n--- Standard Input (with titles & credentials) ---");
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

console.log("\n--- Clean/Pre-normalized Input (fast paths) ---");
benchmark("normalize (already normalized)", () => {
  normalize(cleanA);
});

benchmark("normalizeName (no tokens to strip)", () => {
  normalizeName(cleanA);
});

benchmark("similarityName (already normalized, no tokens to strip)", () => {
  similarityName(cleanA, cleanB);
});
