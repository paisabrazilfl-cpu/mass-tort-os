import {
  levenshtein,
  similarity,
  similarityName,
  normalize,
  normalizeName,
} from "../string-similarity";

const a = "Dr. Micah Edwin, MD";
const b = "Micah Edwin";

const c = "micah edwin";
const d = "micah edwin";

const e = "micah edwin md";
const f = "micah edwin";

const iterations = 100000;

console.log(`Running benchmarks with ${iterations} iterations...\n`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(
    `${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`,
  );
}

console.log("=== Benchmark Case 1: Unnormalized Person Names ===");
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

console.log("\n=== Benchmark Case 2: Already Clean & Normalized Names ===");
benchmark("levenshtein (equal)", () => {
  levenshtein(c, d);
});
benchmark("normalize (already clean)", () => {
  normalize(c);
});
benchmark("normalizeName (already clean)", () => {
  normalizeName(c);
});
benchmark("similarity (already clean)", () => {
  similarity(c, d);
});
benchmark("similarityName (already clean)", () => {
  similarityName(c, d);
});

console.log("\n=== Benchmark Case 3: Strings with Common Prefix/Suffix ===");
benchmark("levenshtein (prefix/suffix overlap)", () => {
  levenshtein(e, f);
});
benchmark("similarity (prefix/suffix overlap)", () => {
  similarity(e, f);
});
benchmark("similarityName (prefix/suffix overlap)", () => {
  similarityName(e, f);
});
