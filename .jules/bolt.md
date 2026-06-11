## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-22 - [Encryption & Dedup Hot-Path Optimization]
**Learning:** AES-GCM decryption with multiple AAD fallback attempts is extremely expensive when the payload is re-decoded from Base64 for each attempt. Passing the correct `entityId` in the lead deduplication loop (where up to 1000 rows are scanned) eliminates these fallback cycles. Header parsing with `split(':')` is slow and potentially incompatible with some Worker environments compared to `indexOf`/`substring`. Lazy cloning in field helpers prevents unnecessary object churn.
**Action:** Always pass `entityId` to decryption in loops if known. Pre-decode Base64 payloads before AAD retry loops. Use lazy cloning (`return result ?? data`) for record transformations. Avoid `split` for simple header parsing in hot paths.
