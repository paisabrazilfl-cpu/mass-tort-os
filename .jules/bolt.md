## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [NPI Search Hoisting]
**Learning:** In candidate search loops (like NPI verification), hoisting the normalization of the search target and pre-normalizing candidate fields once per iteration significantly reduces CPU overhead. Early-break on perfect matches (score >= 1.0) further optimizes the best-case scenario.
**Action:** Always hoist target normalization out of loops. Use `*PreNormalized` variants of similarity helpers when iterating over large result sets.
