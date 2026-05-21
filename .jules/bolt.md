## 2025-05-15 - [Redundant Normalization in String Similarity]
**Learning:** `similarityName` was performing four `normalize()` calls (two inside `similarity(a, b)` and two more via `normalizeName()`). For a 100k-iteration batch, this regex-heavy overhead was significant (~30% of total runtime).
**Action:** Extract internal `*Normalized` helpers to allow reusing normalized strings across multiple similarity passes.

## 2025-05-15 - [Levenshtein GC Pressure]
**Learning:** The previous `levenshtein` implementation used `new Array<number>` and two rows of the matrix, causing high GC pressure in hot loops like NPI verification.
**Action:** Use a single `Int32Array` and swap inputs to ensure the smaller string defines the vector size, reducing allocations and improving cache locality.
