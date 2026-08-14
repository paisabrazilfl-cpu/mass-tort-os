import { levenshtein, similarity, similarityName, normalize, normalizeName } from "../string-similarity";

const a_dirty = "Dr. Micah Edwin, MD";
const b_dirty = "Micah Edwin";

const a_clean = "micah edwin";
const b_clean = "micah edwin";

const iterations = 100000;

console.log(`Running benchmarks with ${iterations} iterations...\n`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

console.log("=== Credentialed / Un-normalized Inputs ===");
benchmark("levenshtein", () => {
  levenshtein(a_dirty, b_dirty);
});

benchmark("normalize", () => {
  normalize(a_dirty);
});

benchmark("normalizeName", () => {
  normalizeName(a_dirty);
});

benchmark("similarity", () => {
  similarity(a_dirty, b_dirty);
});

benchmark("similarityName", () => {
  similarityName(a_dirty, b_dirty);
});

console.log("\n=== Already Clean / Normalized Inputs ===");
benchmark("normalize (clean)", () => {
  normalize(a_clean);
});

benchmark("normalizeName (clean)", () => {
  normalizeName(a_clean);
});

benchmark("similarity (clean)", () => {
  similarity(a_clean, b_clean);
});

benchmark("similarityName (clean)", () => {
  similarityName(a_clean, b_clean);
});
