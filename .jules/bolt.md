## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-08-28 - [Batch Predictive Scoring N+1 Query Optimization]
**Learning:** In batch API endpoints like `getBatchPredictions`, querying IDs first and then looping over each ID to perform individual DB queries creates an N+1 query bottleneck (e.g. 51 DB calls for 50 leads).
**Action:** Extract in-memory scoring/computation helpers (`scoreLeadFromRow`) and fetch full records in a single batch query, reducing DB roundtrips from N+1 to 1.
