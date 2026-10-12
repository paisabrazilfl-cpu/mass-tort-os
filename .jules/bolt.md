## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [OFAC Sanctions Screening Tokenization Optimization]
**Learning:** Performing string normalization, `.split(" ")`, and `new Set()` instantiation per record during linear search across large datasets (e.g. 10,000+ OFAC SDN records) introduces massive garbage collection overhead and repeated string operations.
**Action:** Pre-tokenize names and aliases into pre-computed `Set<string>` collections when building or caching data snapshots. Ensure test snapshot injectors also prepare token sets so queries execute as direct O(1) `Set.has()` membership checks.
