## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [String Normalization & Fast-Path DP Skipping]
**Learning:** Replacing chained regex `.replace()` calls with a single contiguous non-word regex `/[^\w]+/g` cuts string normalization overhead in half by avoiding intermediate string allocations. Pre-testing for token presence (`Regex.test()`) before `.split(" ")` eliminates array heap allocations on clean inputs. Checking if pre-normalized strings were unmodified by stripping filters allows skipping duplicate $O(N \times M)$ Levenshtein DP calculations entirely.
**Action:** Use single-pass non-word regexes for string cleaning. Check reference equality on pre/post-filter strings before re-running expensive fuzzy similarity comparisons.
