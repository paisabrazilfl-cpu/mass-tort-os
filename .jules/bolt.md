## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [NPI Search Hoisting and Similarity Fast Paths]
**Learning:** Re-normalizing loop-invariant expected strings inside the NPI search loop creates significant overhead. Hoisting normalization out of loops and implementing `similarityNamePreNormalizedAndStripped` minimizes CPU cycles. Using RegExp on title/credential checks and simple regex on `normalize` provides up to 10x-40x speedups for clean, already-normalized inputs.
**Action:** Avoid re-normalizing/re-stripping loop-invariant inputs inside search loops. Design helpers that accept pre-processed values to eliminate redundant string parsing.
