## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Fast-Path Bypass for Title/Credential Stripping in Name Similarity]
**Learning:** When inputs contain no title or credential tokens, `normalizeNameFromNormalized` returns the exact same string instance as `normalize()`. Fast-path checking `strippedA === na && strippedB === nb` completely avoids a second Levenshtein calculation on clean non-exact names.
**Action:** Use string reference equality check `strippedA === na && strippedB === nb` after normalization transformations to skip redundant fuzzy comparisons.
