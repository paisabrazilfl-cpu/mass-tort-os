## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Decision Engine Date Parsing & Contradiction Checking Optimization]
**Learning:** In high-throughput scoring loops (such as batch lead re-computations), instantiating `new Date()` objects and re-evaluating RegExp objects on every field check creates heavy GC pressure and CPU overhead. Returning primitive UNIX timestamps (`number | null`) and using fast ASCII character checks (`charCodeAt(4) === 45`) for ISO dates drastically reduces latency.
**Action:** Always parse date inputs into primitive numeric timestamps (`number | null`) for comparisons in hot paths. Cache end-of-day timestamps when comparing dates against current day bounds, and use ASCII character inspection before RegExp calls for standard string format validation.
