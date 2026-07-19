import { levenshtein, similarity, similarityName, normalize, normalizeName } from "../string-similarity";

const a = "Dr. Micah Edwin, MD";
const b = "Micah Edwin";

// Strings with matching prefixes and suffixes
const prefixSuffixA = "Dr. Johnathon Smith, MD";
const prefixSuffixB = "Dr. Jonathan Smith, MD";

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

benchmark("levenshtein (no match)", () => {
  levenshtein(a, b);
});

benchmark("levenshtein (prefix/suffix match)", () => {
  levenshtein(prefixSuffixA, prefixSuffixB);
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
