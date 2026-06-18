## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-20 - [NPI Verification Loop Optimization]
**Learning:** Hoisting normalization of target values out of high-frequency search loops (like NPPES result scoring) and using pre-normalized similarity helpers can yield massive latency reductions (~70%). In `pickBestSearchResult`, avoiding redundant `Array.filter().join()` calls by relying on `normalize()` for whitespace cleanup further reduces GC pressure.
**Action:** Always hoist invariant normalization out of loops. Implement `*PreNormalized` variants of fuzzy matching helpers to allow reuse of already-calculated normalizations.
