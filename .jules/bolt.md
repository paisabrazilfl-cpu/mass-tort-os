## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2026-05-31 - [Encryption Performance Optimization]
**Learning:** In high-throughput encryption/decryption paths, `process.env` lookups and regex-based validation for hex keys add significant latency. Repeated `Buffer.from()` calls for static values (like field names used as AAD) and string `split`/`join` for header parsing contribute to unnecessary GC pressure.
**Action:** Use `keyCache` and `aadCache` (Map<string|number, Buffer>) to store pre-resolved buffers. Optimize header parsing using `indexOf`/`slice` to avoid intermediate array allocations.
