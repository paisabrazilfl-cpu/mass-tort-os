## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2026-05-02 - [NPI Verification Loops & String Fast Paths]
**Learning:** Hoisting string normalizations out of result iteration loops yields massive performance gains in search operations like `pickBestSearchResult`. Additionally, fast-path checks for space-less strings (`indexOf(" ") === -1`) can completely bypass split/filter/join arrays, eliminating GC allocation.
**Action:** Always hoist invariant loop normalizations and implement cheap fast-path string checks before doing regexes or array-based string slicing.
