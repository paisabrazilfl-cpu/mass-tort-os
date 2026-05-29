import assert from "node:assert";
import test from "node:test";
import {
  levenshtein,
  similarity,
  similarityName,
  normalize,
  normalizeName,
} from "../string-similarity";

test("levenshtein", () => {
  assert.strictEqual(levenshtein("", ""), 0);
  assert.strictEqual(levenshtein("a", ""), 1);
  assert.strictEqual(levenshtein("", "a"), 1);
  assert.strictEqual(levenshtein("abc", "abc"), 0);
  assert.strictEqual(levenshtein("abc", "abd"), 1);
  assert.strictEqual(levenshtein("kitten", "sitting"), 3);
  assert.strictEqual(levenshtein("sitting", "kitten"), 3);
  assert.strictEqual(levenshtein("flaw", "lawn"), 2);
  assert.strictEqual(levenshtein("gumbo", "gambol"), 2);
});

test("similarity", () => {
  assert.strictEqual(similarity("abc", "abc"), 1);
  assert.strictEqual(similarity("abc", "abd"), 1 - 1 / 3);
  assert.strictEqual(similarity("", ""), 1);
  assert.strictEqual(similarity("abc", ""), 0);
});

test("normalize", () => {
  assert.strictEqual(normalize("  Hello,   World!  "), "hello world");
});

test("normalizeName", () => {
  assert.strictEqual(normalizeName("Dr. John Smith, MD"), "john smith");
  assert.strictEqual(normalizeName("MD"), "");
});

test("similarityName", () => {
  assert.strictEqual(similarityName("Dr. Micah Edwin, MD", "Micah Edwin"), 1);
  assert.strictEqual(similarityName("John Smith", "John Smith"), 1);
  assert.ok(similarityName("John Smith", "John Smyth") > 0.8);
});
