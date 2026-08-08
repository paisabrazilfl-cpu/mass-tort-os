## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [String Similarity Fast Paths and Double-Ended Levenshtein]
**Learning:** Regex replacement and array allocations (split/filter/join) are a major bottleneck in hot string similarity checks. Checking for pre-normalized strings via character codes and doing word-boundary regex testing first can bypass these expensive operations, yielding up to a 30x throughput improvement. Double-ended prefix/suffix trimming in Levenshtein, implemented via direct index tracking rather than slicing, avoids allocations entirely and accelerates matching of strings with common boundaries by over 7x.
**Action:** Always implement fast-path checks using direct character index scanning or pre-compiled word-boundary regex tests before executing complex string formatting and matching routines.
