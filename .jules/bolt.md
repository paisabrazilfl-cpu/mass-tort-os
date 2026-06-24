## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-06-01 - [Encryption Hot Path Optimization]
**Learning:** `process.env` lookups and hex-to-buffer conversions in `getKey` are expensive when called for every encrypted field (e.g., in `decryptLeadArray`). `split(':')` on ciphertext headers creates unnecessary array allocations. Decoding the same base64 payload multiple times in AAD fallback loops is redundant.
**Action:** Implement a `keyCache` for resolved encryption keys. Use `indexOf` and `slice` for structured string parsing. Decode base64 payloads once and reuse the `Buffer` across fallback attempts.
