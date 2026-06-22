## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.
## 2026-06-22 - [Validation & Search Hot-Path Optimization]
**Learning:** Hoisting normalization out of loops and reusing pre-normalized strings via specialized helpers (e.g., `similarityPreNormalized`) is the single most effective way to optimize fuzzy-matching hot paths. Combined with regex hoisting and early-breaks on perfect matches, NPI search loop latency was reduced by ~23% even with a small result set.
**Action:** Always prefer `PreNormalized` variants of similarity functions inside loops. Hoist static regex and normalization to the highest possible scope.
