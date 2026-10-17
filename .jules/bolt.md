## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Batch Query N+1 Elimination in Predictive Scoring]
**Learning:** Functions that perform batch predictive calculations (such as `getBatchPredictions`) can easily hide N+1 query patterns when calling individual ID-based lookup routines in a loop.
**Action:** Always separate pure record scoring (`scoreLeadRecord`) from database queries (`scoreLeadPredictive`), and perform single batch queries (`db.select().from().where().limit()`) when processing multiple items.
