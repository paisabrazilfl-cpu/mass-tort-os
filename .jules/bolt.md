## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-20 - [NPI Search Loop Optimization]
**Learning:** Hoisting normalization and using pre-normalized similarity helpers in high-frequency loops (like NPI provider matching) significantly reduces latency. Simplified name assembly (template literals instead of `filter.join`) further reduces allocation overhead. Early-break on perfect matches (`score >= 1.0`) is a cheap win for high-quality data.
**Action:** Always hoist normalization out of loops. Implement and export `PreNormalized` variants of similarity functions. Replace expensive array operations with simple string templates for basic concatenations.
