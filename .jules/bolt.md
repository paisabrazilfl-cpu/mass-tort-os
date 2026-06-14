## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Encryption & Lead Field Optimization]
**Learning:** Redundant base64 decoding and key resolution inside AAD fallback loops is a measurable bottleneck. `split(':').join(':')` is slower than `substring` and can cause compatibility issues in some worker environments. Shallow cloning large lead objects in every process (even when no fields change) creates unnecessary GC pressure.
**Action:** Pre-decode base64 payloads to a `Buffer` and resolve the key ONCE before entering decryption retry loops. Implement 'lazy cloning' in object transformation helpers: only return a new object if a field was actually modified.
