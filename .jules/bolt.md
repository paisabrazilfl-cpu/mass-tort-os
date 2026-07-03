## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-20 - [IDS Middleware Optimization]
**Learning:** Consolidating multiple sequential regex `.test()` calls into single category-specific regular expressions using OR pipes (`(?:...)`) significantly reduces regex engine overhead per request string. Recursive object scanning (`deepScan`) is heavily penalized by `Object.entries()` allocations; switching to `for...in` and indexed `for` loops for arrays drastically reduces memory pressure and latency.
**Action:** Consolidate threat patterns and avoid `Object.entries` in recursive hot-path traversal. Use manual string parsing (`indexOf`/`substring`) instead of `split`/`trim`/`startsWith` to ensure Cloudflare Worker compatibility and avoid prohibited method overhead.
