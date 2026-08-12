## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2026-05-18 - [NPI Verification Best Match Optimization]
**Learning:** Performing multiple redundant normalization and credential-stripping operations per loop iteration on loop-invariant variables is extremely costly. By hoisting the normalizations and credential-strippings of the search fields outside of the `pickBestSearchResult` loop, and providing a direct pre-normalized similarity helper, we avoid redundant calculations and GC overhead.
**Action:** Always identify and hoist loop-invariant normalization, parsing, and regex/token-stripping computations outside search/matching loops. Provide specialized pre-normalized comparison APIs to maximize performance of hot paths.
