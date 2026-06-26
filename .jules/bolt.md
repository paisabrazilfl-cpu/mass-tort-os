## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Encryption Hot Path Optimizations]
**Learning:** `decryptLeadFields` and `encryptLeadFields` often process already-encrypted or plaintext data; lazy cloning avoids thousands of redundant object allocations. In `decrypt`, unrolling the AAD fallback loop and pre-decoding the base64 payload once (instead of per-fallback attempt) significantly reduces CPU and GC pressure.
**Action:** Use 'lazy cloning' for bulk record processing. Avoid array allocations and repeated string/base64 processing in fallback chains. Use `indexOf` and `substring` for header parsing instead of `split`.
