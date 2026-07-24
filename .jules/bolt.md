## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Fast-Path Optimization for String Similarity]
**Learning:** Double similarity computations and array operations (like `.split().filter().join()`) are hot bottlenecks in name matching. Short-circuiting single-word tokens with `indexOf(" ") === -1` completely avoids GC pressure. String reference comparison `strippedA === na && strippedB === nb` is extremely fast and avoids redundant O(N*M) Levenshtein computations when no titles/credentials are found.
**Action:** Always identify if a text processing step actually alters the input before executing downstream logic. Use identity equality checks (`===`) between pre- and post-processed states to bypass redundant calculations.
