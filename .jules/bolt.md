## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Tort Engine Validation Optimization]
**Learning:** Performing dynamic `Object.keys().find()` scans and `Object.entries()` categorizations on every claim validation or form retrieval creates repeated linear array/object allocations. Pre-computing lookup maps and category lists at module load time turns runtime search overhead into O(1) direct map lookups and zero-allocation static reads.
**Action:** Pre-compute module-scoped `Map` instances for string lookups and cache static structured metadata at module scope.
