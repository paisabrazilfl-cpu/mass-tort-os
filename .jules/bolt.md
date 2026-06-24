## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-22 - [Normalization Hoisting in Search Loops]
**Learning:** Calling `normalize()` or `similarity()` (which calls `normalize()` internally) on constant inputs inside a loop is a significant waste of CPU, especially when using regex-heavy normalizers. Hoisting these to pre-normalized variables outside the loop is essential for performance in search/matching logic.
**Action:** Always pre-normalize "expected" values or search queries before entering a loop that compares them against many candidates. Use `PreNormalized` helper variants to bypass redundant processing inside the loop.
