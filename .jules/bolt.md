## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Email Validation Performance Optimization]
**Learning:** In high-frequency input validation libraries, array linear scans (e.g. `Array.includes()`), dynamic `RegExp` instantiations inside function bodies, and string splitting (`split("@")`) accumulate latency and GC allocations.
**Action:** Convert static domain lookup arrays to `Set<string>`, hoist static regexes to module scope, extract substrings using `indexOf("@")` index slicing, and add fast-path early returns for standard valid TLDs and common provider domains.
