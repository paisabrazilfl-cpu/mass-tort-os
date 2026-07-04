## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-20 - [IDS Optimization & Worker Compatibility]
**Learning:** In the 'mtosvelocity' Cloudflare Worker build environment, standard string and array methods like `startsWith`, `slice`, `split`, `join`, `trim`, `Object.keys`, and `Map.entries` cause build failures in CI if used in modules reachable by the worker entry point. Furthermore, `setInterval().unref()` is not supported.
**Action:** Use manual `indexOf`, `substring`, regex-based trimming, and `for...in` / `forEach` loops for compatibility. Guard Node.js-specific calls like `.unref()` with environment checks. Programmatically generate aggregate regexes using manual loops to maintain both security and performance without triggering build errors.
