## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2026-06-28 - [IDS Middleware Scanning Optimization]
**Learning:** Combining multiple sequential regex tests into category-specific regular expressions using OR pipes significantly reduces CPU overhead. Replacing `Object.entries()` with `for...in` for object traversal and indexed `for` loops for arrays avoids expensive temporary array allocations during deep recursion.
**Action:** Use consolidated regexes for O(1) category matching. Avoid `Object.entries()` or `Object.values()` in hot traversal paths to minimize GC pressure on large JSON payloads.
