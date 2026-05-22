import { describe, it } from "node:test";
import assert from "node:assert";
import { normalize, normalizeName, similarity, similarityName, levenshtein } from "../string-similarity";

describe("string-similarity", () => {
  describe("normalize", () => {
    it("should lowercase and strip punctuation", () => {
      assert.strictEqual(normalize("Hello, World!"), "hello world");
      assert.strictEqual(normalize("  Multiple   Spaces  "), "multiple spaces");
    });

    it("should handle null/undefined", () => {
      assert.strictEqual(normalize(null), "");
      assert.strictEqual(normalize(undefined), "");
    });
  });

  describe("normalizeName", () => {
    it("should strip titles and credentials", () => {
      assert.strictEqual(normalizeName("Dr. John Smith MD"), "john smith");
      assert.strictEqual(normalizeName("John Smith, Esq."), "john smith");
    });
  });

  describe("levenshtein", () => {
    it("should calculate correct distance", () => {
      assert.strictEqual(levenshtein("kitten", "sitting"), 3);
      assert.strictEqual(levenshtein("flaw", "lawn"), 2);
      assert.strictEqual(levenshtein("", "abc"), 3);
      assert.strictEqual(levenshtein("abc", ""), 3);
      assert.strictEqual(levenshtein("abc", "abc"), 0);
    });
  });

  describe("similarity", () => {
    it("should return 1 for identical strings", () => {
      assert.strictEqual(similarity("apple", "apple"), 1);
    });

    it("should return 0 for totally different strings", () => {
      assert.strictEqual(similarity("apple", "banana"), 0);
    });

    it("should handle normalization", () => {
      assert.strictEqual(similarity("Apple", "apple!"), 1);
    });
  });

  describe("similarityName", () => {
    it("should match names with different titles", () => {
      assert.strictEqual(similarityName("Dr. John Smith", "John Smith"), 1);
    });
  });
});
