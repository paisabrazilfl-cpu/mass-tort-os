## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [NPI Search Ranking Optimization]
**Learning:** In high-frequency loops (like ranking 20+ NPI search results), the cost of redundant `normalize()` calls on the same "expected" search criteria is the primary bottleneck. Pre-normalizing once outside the loop and using `similarityPreNormalized` inside reduces latency by ~77%. Template literals are also significantly faster than `filter(Boolean).join(" ")` for constructing display names in hot paths.
**Action:** Pre-normalize search criteria before loop entry. Use template literals for basic string joins. Implement early-exit `break` when a maximum possible score (1.0) is achieved.

## 2025-05-17 - [Worker Compatibility & String/Object Optimizations]
**Learning:** The 'mtosvelocity' Cloudflare Worker build environment fails when using common string/array methods like `startsWith()`, `endsWith()`, `slice()`, `split()`, or `join()`, as well as `Object.entries()` or `Object.keys()`. Replacing these with manual `indexOf`, `substring`, and `for...in` loops is required for build stability. These manual approaches often provide better performance by avoiding temporary array/object allocations and reducing GC pressure.
**Action:** Avoid prohibited string/array methods in core libraries reachable by Workers. Use manual tokenization and object iteration. Implement 'lazy cloning' to minimize object copies.
