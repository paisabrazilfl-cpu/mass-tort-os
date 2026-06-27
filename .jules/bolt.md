## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Validator and NPI Search Optimization]
**Learning:** Hoisting static regex patterns and pre-calculating normalized values for reference strings outside of loops yields measurable performance gains in validation and search paths. Common prefix/suffix skipping in Levenshtein significantly reduces workload for similar strings.
**Action:** Always hoist static regex to the module level. In search loops, normalize the "expected" or "target" value once before entering the loop. Implement early breaks in search loops when a perfect match is found.
