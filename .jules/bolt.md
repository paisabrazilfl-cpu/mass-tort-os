## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [IDS Payload Security Scanning Optimization]
**Learning:** Running dozens of complex security regexes and allocating key-value pair tuple arrays via `Object.entries()` on every request payload in Express middleware creates high GC pressure and CPU latency on every endpoint hit. Strings under 3 characters can never match multi-character injection patterns, and cheap trigger character regex pre-checks can bypass entire regex families when trigger symbols are absent.
**Action:** In payload security scanners, apply string length fast paths (`length < 3`), pre-check trigger character classes before running full regex suites, and iterate over object keys with `for ... in` / `Array.isArray()` to eliminate tuple allocations.
