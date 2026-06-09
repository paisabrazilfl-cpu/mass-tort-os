## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [NPI Search Loop Optimization]
**Learning:** Hoisting string normalization outside of high-frequency loops and using pre-normalized similarity helpers reduces O(N*K) work to O(N+K) string operations. Early-break logic on perfect matches (score >= 1.0) eliminates redundant processing once an optimal candidate is found.
**Action:** Pre-calculate normalized search targets before entering loops. Provide and use `*PreNormalized` variants of similarity functions. Implement early breaks in search loops for perfect matches.
