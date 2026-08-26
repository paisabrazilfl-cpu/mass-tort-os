## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Address Validator Regex & Allocation Optimization]
**Learning:** In utility functions called frequently on intake forms (like `validateAddress`), allocating inline arrays of RegExp objects and intermediate arrays to check field data (e.g. `garbagePatterns`) creates avoidable GC pressure and nested loop overhead.
**Action:** Consolidate multiple static pattern regexes into a single module-scoped RegExp and cache trimmed string variables at function entry to eliminate per-call object allocations.
