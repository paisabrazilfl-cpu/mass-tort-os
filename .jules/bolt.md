## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Encryption/Decryption Hot-Path Optimization]
**Learning:** In high-throughput cryptographic operations, string manipulation (`split`, `slice`) and redundant allocations (`Buffer.from` in loops) are measurable bottlenecks. `indexOf` + `substring` is significantly faster than `split(':')` for header parsing. Pre-decoding base64 payloads once before attempting multiple AAD variants eliminates redundant decoding work. Lazy cloning of objects in mass-processing functions (`encryptLeadFields`, `decryptLeadFields`) prevents unnecessary GC pressure.
**Action:** Use `indexOf`/`substring` for header parsing. Hoist `Buffer.from` and key resolution out of candidate loops. Implement lazy cloning with the `return result ?? data` pattern.
