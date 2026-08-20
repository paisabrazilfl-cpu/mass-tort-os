## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-15 - [OFAC Treasury SDN Pre-Tokenization]
**Learning:** In linear-scan lookup tables (like OFAC SDN screening over ~10,000 entries), running string normalizations, `.split(" ")`, and `new Set()` inside search loops creates massive CPU and GC pressure (~30ms/query). Pre-tokenizing entry strings into normalized `Set<string>` caches at snapshot-load time reduces query latency by ~20x down to ~1.48ms per search.
**Action:** Always pre-tokenize static or snapshot dataset entries at load time so hot-path query loops perform O(1) `Set.has()` lookups without string operations or object allocations.
