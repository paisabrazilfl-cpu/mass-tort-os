## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [IDS Middleware Scan Optimization]
**Learning:** In request security middleware (`ids.ts`), running 22 complex regex patterns on every query parameter and body field creates high CPU overhead on clean requests. `Object.entries()` allocations during deep scanning generate significant Garbage Collection pressure.
**Action:** Add a short-string guard (`!value || value.length < 2`) and pre-check trigger regexes (`HAS_SQL_TRIGGER`, `HAS_XSS_TRIGGER`, `HAS_PATH_TRIGGER`, `HAS_COMMAND_TRIGGER`) before running expensive full pattern arrays. Replace `Object.entries()` with `Array.isArray()` loops and direct `for ... in` iterations to eliminate array tuple allocations on every object node.
