import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, normalizeName, similarity, similarityName, levenshtein } from "../string-similarity.ts";

test("levenshtein distance", () => {
  assert.equal(levenshtein("", ""), 0);
  assert.equal(levenshtein("a", ""), 1);
  assert.equal(levenshtein("", "b"), 1);
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("rosettacode", "raisethysword"), 8);
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("abc", "abd"), 1);
});

test("normalize", () => {
  assert.equal(normalize("Dr. John Smith, MD"), "dr john smith md");
  assert.equal(normalize("  John   Smith  "), "john smith");
  assert.equal(normalize("!!!Hello, World!!!"), "hello world");
  assert.equal(normalize(null), "");
  assert.equal(normalize(undefined), "");
});

test("normalizeName", () => {
  assert.equal(normalizeName("Dr. John Smith MD"), "john smith");
  assert.equal(normalizeName("Mr. Robert J. Brown Jr."), "robert j brown");
  assert.equal(normalizeName("Ms. Jane Doe"), "jane doe");
  assert.equal(normalizeName(""), "");
});

test("similarity ratio", () => {
  assert.equal(similarity("kitten", "sitting"), 1 - 3 / 7);
  assert.equal(similarity("abc", "abc"), 1);
  assert.equal(similarity("abc", "def"), 0);
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("a", ""), 0);
});

test("similarityName", () => {
  // Should be high because stripped version matches exactly
  const score1 = similarityName("Dr. John Smith MD", "John Smith");
  assert.equal(score1, 1);

  // Should handle partial matches
  const score2 = similarityName("Robert Brown", "Rob Brown");
  assert.ok(score2 > 0.5 && score2 < 1);

  // Higher of raw and stripped
  const a = "Dr. John Smith";
  const b = "John Smith";
  const raw = similarity(a, b);
  const stripped = similarity(normalizeName(a), normalizeName(b));
  assert.equal(similarityName(a, b), Math.max(raw, stripped));
});
