import { levenshtein, similarity, similarityName, normalize, normalizeName } from "../string-similarity";

const a = "Dr. Micah Edwin, MD";
const b = "Micah Edwin";

// Clean name pair without title or credential tokens to demonstrate the fast path
const aClean = "Micah Edwin";
const bClean = "John Doe";

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

benchmark("levenshtein (with titles)", () => {
  levenshtein(a, b);
});

benchmark("normalize", () => {
  normalize(a);
});

benchmark("normalizeName (with titles)", () => {
  normalizeName(a);
});

benchmark("normalizeName (clean - fast-path)", () => {
  normalizeName(aClean);
});

benchmark("similarity (with titles)", () => {
  similarity(a, b);
});

benchmark("similarityName (with titles)", () => {
  similarityName(a, b);
});

benchmark("similarityName (clean - fast-path)", () => {
  similarityName(aClean, bClean);
});
