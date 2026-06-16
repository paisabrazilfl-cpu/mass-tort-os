## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-06-16 - [NPI Registry Search Optimization]
**Learning:** Hoisting normalization of search targets out of the results loop and adding an early break for perfect matches (score >= 1.0) significantly reduces latency in provider verification. Repeatedly calling `normalize()` and `similarityName()` inside a loop over NPPES results is a major bottleneck.
**Action:** Pre-normalize expected provider fields before the search loop. Use `similarityPreNormalized` and `similarityNamePreNormalized` helpers to avoid redundant processing. Break early when a perfect match is found.
