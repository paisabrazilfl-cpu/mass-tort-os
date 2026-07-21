## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [NPI Verifier Candidate Search Optimization]
**Learning:** Evaluating multiple fuzzy candidates in `pickBestSearchResult` causes $O(C \times L)$ normalizations, where $C$ is candidates and $L$ is loop invariants, leading to high GC pressure and redundant processing. Hoisting normalization of invariant search fields and caching candidate string conversions once dramatically reduces CPU overhead. An early exit on an exact match (score >= 1.0) completely skips remaining search candidates.
**Action:** Always hoist loop-invariant normalizations out of evaluation loops. Cache candidate-specific normalizations inside the loop, and use pre-normalized similarity helpers. Implement early-exit conditions when perfect match scores are reached.
