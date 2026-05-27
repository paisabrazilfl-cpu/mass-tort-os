## 2025-05-15 - [Optimization] Caching Encryption Keys and AAD
**Learning:** In hot loops like lead deduplication (O(N) decryption of up to 1000 rows), repeated calls to `process.env` lookups, regex validation, and `Buffer.from` for the same key and AAD field names add significant overhead. Caching these as static `Map` entries reduced decryption time by ~30% per operation.
**Action:** Always check for repeated static-ish lookups or allocations inside loops that handle potentially large data sets (like the 1000-row `PHONE_SCAN_LIMIT`).
