## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Fraud Engine Date & String Allocation Optimization]
**Learning:** Instantiating `new Date()` objects repeatedly during timeline validation creates significant heap allocation overhead and GC pressure. Using `Date.parse()` to work directly with primitive timestamps and hoisting condition lists avoids dynamic allocations in fraud evaluation pipelines.
**Action:** Use `Date.parse()` for date validation, `Date.now()` for current time checks, and replace `.some()` or `.map().join()` with indexed loops when constructing indicator summaries in hot paths.
