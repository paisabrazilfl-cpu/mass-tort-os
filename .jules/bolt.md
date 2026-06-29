## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-20 - [Core Utilities Optimization]
**Learning:** Hoisting regex patterns to the module level and using manual loops (for...in/indexed for) instead of high-level array methods (Object.entries/filter/map) in hot recursive paths like IDS scanning significantly reduces GC pressure and per-call overhead. In Levenshtein, prefix and suffix skipping is a massive win for comparing real-world data like addresses or person names that often share common structures.
**Action:** Always hoist static regexes and constants. Prefer simple loops over `Object.entries` in high-frequency traversal logic. Implement common-substring short-circuiting in fuzzy matching algorithms.
