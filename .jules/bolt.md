## 2025-05-15 - String Similarity & Levenshtein Optimization
**Learning:** Redundant regex-heavy normalization and multiple Levenshtein passes significantly slow down fuzzy name matching. Using `Int32Array` for the Levenshtein vector and swapping strings to ensure the shorter one is used for allocation minimizes GC pressure.
**Action:** Always reuse normalized strings in multi-pass similarity checks. Use single-vector `Int32Array` for $O(\min(n, m))$ space complexity in Levenshtein.
