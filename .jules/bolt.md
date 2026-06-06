## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Loop Hoisting for Normalization]
**Learning:** High-frequency loops calling fuzzy matching (like NPI search results) benefit significantly (~34%) from hoisting target-string normalization. Shared similarity helpers should expose "PreNormalized" variants that accept an optional pre-stripped version of the input to avoid $O(N)$ regex overhead.
**Action:** Expose `similarityNamePreNormalized(na, nb, naStripped?)` to allow callers to pre-process once and match against many.
