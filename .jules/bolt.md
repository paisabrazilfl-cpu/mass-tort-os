## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-22 - [IDS Scanning Optimization]
**Learning:** Sequential regex .test() calls on large payloads and recursive Object.entries() in deep scanners cause significant overhead due to both execution time and temporary array allocations. Consolidated regexes and manual for...in/for loops drastically improve throughput.
**Action:** Consolidate multiple related regex patterns into single expressions using non-capturing groups. Replace Object.entries() with for...in + hasOwnProperty in recursive object walkers to avoid garbage collection pressure from intermediate arrays.
