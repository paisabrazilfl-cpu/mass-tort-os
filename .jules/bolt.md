## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [State Code Normalization Map Lookup]
**Learning:** Performing linear searches over state dictionary objects via `Object.entries()` inside normalization functions allocates array tuples (`[key, value]`) and lowercases string labels on every call. Pre-computing a module-level `Map<string, string>` converts $O(N)$ string scans with object allocations into $O(1)$ constant-time lookups with zero per-call garbage.
**Action:** Always pre-build module-scope lookup `Map`s for static label/dictionary mappings that are repeatedly queried by normalization helpers.
