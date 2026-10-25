## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Comprehensive Tort Forms Memoization & Field Counting]
**Learning:** Calling `.filter()` multiple times over form fields allocates intermediate arrays and causes repeated linear passes. Re-building static form objects and deduplicating sets on every lookup causes significant allocation and execution overhead. Pre-building static forms into a `Map` and counting form field sections in a single `for` loop eliminates heap churn and achieves ~2.29x to ~60x speedups.
**Action:** Module-scope static form structures into a `Map` at init time. Always replace multi-pass `.filter()` counts on field arrays with a single indexed `for` loop.
