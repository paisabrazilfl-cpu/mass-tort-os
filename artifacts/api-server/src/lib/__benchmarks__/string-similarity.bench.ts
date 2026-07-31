import { levenshtein, similarity, similarityName, normalize, normalizeName } from "../string-similarity";

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

console.log("\n--- Unclean input with titles/credentials (a = 'Dr. Micah Edwin, MD', b = 'Micah Edwin') ---");
const a = "Dr. Micah Edwin, MD";
const b = "Micah Edwin";
benchmark("levenshtein", () => { levenshtein(a, b); });
benchmark("normalize", () => { normalize(a); });
benchmark("normalizeName", () => { normalizeName(a); });
benchmark("similarity", () => { similarity(a, b); });
benchmark("similarityName", () => { similarityName(a, b); });

console.log("\n--- Clean pre-normalized input (a_clean = 'micah edwin', b_clean = 'micah edwin') ---");
const a_clean = "micah edwin";
const b_clean = "micah edwin";
benchmark("normalize (clean)", () => { normalize(a_clean); });
benchmark("normalizeName (clean)", () => { normalizeName(a_clean); });
benchmark("similarityName (clean)", () => { similarityName(a_clean, b_clean); });

console.log("\n--- Input with common prefix/suffix (a_affix = 'Dr. Johnathan Smith III', b_affix = 'Dr. Jonathan Smith III') ---");
const a_affix = "Dr. Johnathan Smith III";
const b_affix = "Dr. Jonathan Smith III";
benchmark("levenshtein (affix)", () => { levenshtein(a_affix, b_affix); });
