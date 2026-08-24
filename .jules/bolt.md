## 2026-06-04 - [Null Prototype Reverse Lookups]
**Learning:** Pre-computing reverse lookup objects from static dictionaries eliminates repeated `Object.entries()` allocations and loop iterations. However, using `{}` can leak prototype properties like `"toString"` or `"constructor"`. Using `Object.create(null)` creates a clean dictionary with no prototype properties.
**Action:** Always initialize pre-computed string lookup tables with `Object.create(null)` instead of `{}`.

## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.
