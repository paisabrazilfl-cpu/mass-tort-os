## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2026-07-12 - [IDS Threat Scanning Optimization]
**Learning:** Consolidating multiple sequential regex `.test()` calls into single category-specific regular expressions using OR pipes (`(?:...)`) significantly reduces regex engine overhead. Replacing `Object.entries()` with manual `for...in` and indexed loops in recursive functions (`deepScan`) eliminates substantial GC pressure from temporary array allocations.
**Action:** Always prefer consolidated regexes for high-frequency scanning. Use manual loops (`for...in`, indexed `for`) instead of `Object.entries/keys/values` or functional iterators (`.map`, `.forEach`) in hot paths to minimize allocations and ensure environment compatibility.
