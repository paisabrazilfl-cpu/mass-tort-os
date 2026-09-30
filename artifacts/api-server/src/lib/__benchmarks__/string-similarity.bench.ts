import { levenshtein, similarity, similarityName, normalize, normalizeName } from "../string-similarity";

const titleA = "Dr. Micah Edwin, MD";
const titleB = "Micah Edwin";
const cleanA = "Micah Edwin";
const cleanB = "Micha Edwin";

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
  levenshtein(titleA, titleB);
});

benchmark("normalize", () => {
  normalize(titleA);
});

benchmark("normalizeName (clean)", () => {
  normalizeName(cleanA);
});

benchmark("normalizeName (title)", () => {
  normalizeName(titleA);
});

benchmark("similarity", () => {
  similarity(titleA, titleB);
});

benchmark("similarityName (clean non-exact)", () => {
  similarityName(cleanA, cleanB);
});

benchmark("similarityName (title)", () => {
  similarityName(titleA, titleB);
});
