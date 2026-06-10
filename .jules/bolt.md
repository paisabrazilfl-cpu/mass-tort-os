## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Normalization Hoisting in Search Loops]
**Learning:** Redundant normalization inside a search loop (e.g. `pickBestSearchResult`) can be the dominant cost of fuzzy matching. Hoisting normalization of the 'expected' target fields and using pre-normalized similarity helpers reduces loop latency by ~88% when multiple candidates are present.
**Action:** Always hoist normalization of static/expected values outside of loops. Export and use `*PreNormalized` similarity variants to bypass redundant regex work in high-frequency iterations.
