## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2026-05-20 - [Taxonomy Engine Pre-computation]
**Learning:** Calling `Object.entries()` inside hot validation loops creates intermediate tuple arrays on every single invocation. Similarly, calling `.toLowerCase()` on static reference array elements inside `Array.prototype.some` callbacks incurs repeated string allocations.
**Action:** Pre-compute module-scoped `TAXONOMY_DIAGNOSIS_ENTRIES` and pre-lowercased lookup maps (`SPECIALTY_CATEGORY_MAP_LOWER`) at module load. Replace `Array.prototype.some` callback closures with direct `for` loops with early breaks.
