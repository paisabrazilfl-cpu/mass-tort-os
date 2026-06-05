## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-20 - [Encryption and Dedup Optimization]
**Learning:** Payload decoding (base64 to Buffer) and key resolution in `decrypt` are expensive and should be done once before entering fallback AAD loops. Lazy cloning (copy-on-write) for field transformation helpers significantly reduces GC pressure for "noop" calls. Passing `entityId` in lead deduplication loops avoids costly fallback decryption cycles by hitting the "bound" AAD format immediately.
**Action:** Move payload decoding and key resolution outside of fallback loops. Use `return result ?? data` pattern for lazy cloning. Always pass `entityId` to decryption utilities in hot loops if the ID is known.
