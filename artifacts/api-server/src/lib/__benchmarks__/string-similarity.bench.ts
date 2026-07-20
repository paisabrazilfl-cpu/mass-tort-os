import {
  levenshtein,
  similarity,
  similarityName,
  normalize,
  normalizeName,
} from "../string-similarity";

const a = "Dr. Micah Edwin, MD";
const b = "Micah Edwin";

const a_margins = "Dr. Micah Edwin, MD";
const b_margins = "Dr. Micah B. Edwin, MD";

const iterations = 100000;

console.log(`Running benchmarks with ${iterations} iterations...`);

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

benchmark("levenshtein (no common margins)", () => {
  levenshtein(a, b);
});

benchmark("levenshtein (common prefix and suffix)", () => {
  levenshtein(a_margins, b_margins);
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
