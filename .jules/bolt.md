## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Levenshtein Prefix/Suffix Skipping & Name Normalization Avoidance]
**Learning:** For strings with common prefixes or suffixes (extremely common in name verification where credentials like MD/Dr are added, or slight middle initials differ), skipping the matching common segments reduces the Levenshtein DP calculation space dramatically, yielding up to a 3.4x speedup. Furthermore, checking if strings are changed by token-stripping (e.g. `strippedA === na`) allows bypassing secondary Levenshtein evaluations entirely.
**Action:** Find character divergence boundaries from the start and end of strings, and slice them out before running Levenshtein. Add fast-paths like `indexOf(" ") === -1` to avoid array allocation in single-token string normalization.
