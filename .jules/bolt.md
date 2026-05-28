## 2025-05-15 - Optimized String Similarity and Levenshtein Distance
**Learning:** Reusing normalized strings in fuzzy matching prevents redundant regex and split/join overhead. Switching to a single-vector `Int32Array` for Levenshtein distance significantly improves CPU cache locality and reduces memory allocations. Space complexity is reduced to $O(\min(N, M))$.
**Action:** Always check for redundant normalization in string processing loops. Use `Int32Array` for matrix-based algorithms in Hot Paths.
