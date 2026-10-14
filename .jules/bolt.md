## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-18 - [Avoid Inner Function Closures in Hot Paths]
**Learning:** Instantiating inner helper closure functions (such as `addError`) inside hot validation functions creates per-call function object heap allocations and invocation frame overhead.
**Action:** Keep validation and error collection logic inline or use outer module-level helper functions in hot validation routines.
