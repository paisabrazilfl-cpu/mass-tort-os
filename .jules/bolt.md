## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2026-05-15 - [Snapshot Sanitizer Object Entries Allocation]
**Learning:** `Object.entries(obj)` creates an array of `[key, value]` 2-element tuples for every property on an object. In recursive object traversal functions (like PII masking over JSON payloads), this causes millions of unnecessary array allocations under load. `for...in` guarded with `Object.hasOwn` eliminates tuple allocations entirely while remaining fully idiomatic and readable.
**Action:** Use `for...in` + `Object.hasOwn(obj, k)` for recursive object traversal instead of `Object.entries(obj)` when transforming object trees.
