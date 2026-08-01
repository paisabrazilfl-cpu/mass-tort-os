## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2026-07-31 - [String Similarity Fast-Paths]
**Learning:** Checking if a string is already pre-normalized via a fast character scan loop completely bypasses expensive RegExp replacements and trim allocations. Similarly, compiling a single regex from title/credential sets avoids split-filter-join overhead on common names, and reference checking matching-stripped names bypasses redundant Levenshtein matrix calculations completely.
**Action:** Always check `isNormalized` before invoking regex-based cleanup on strings, use dynamic RegExp compilation from static Sets to prevent maintenance drift, and leverage reference equality early-exits to skip complex fuzzy matching algorithms.
