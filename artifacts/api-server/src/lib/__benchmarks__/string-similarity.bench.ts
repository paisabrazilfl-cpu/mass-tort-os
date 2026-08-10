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

benchmark("levenshtein", () => {
  levenshtein(a, b);
});

benchmark("normalize (unclean)", () => {
  normalize(a);
});

benchmark("normalize (already clean/normalized)", () => {
  normalize(cleanA);
});

benchmark("normalizeName (unclean)", () => {
  normalizeName(a);
});

benchmark("normalizeName (already clean/normalized)", () => {
  normalizeName(cleanA);
});

benchmark("similarity (unclean)", () => {
  similarity(a, b);
});

benchmark("similarity (already clean/normalized)", () => {
  similarity(cleanA, cleanB);
});

benchmark("similarityName (unclean)", () => {
  similarityName(a, b);
});

benchmark("similarityName (already clean/normalized)", () => {
  similarityName(cleanA, cleanB);
});
