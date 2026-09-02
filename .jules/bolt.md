## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Tort Engine Registry Lookup & Category Caching Optimization]
**Learning:** Performing `Object.keys(REGISTRY).find(...)` with string `.toLowerCase()` inside hot request/validation paths creates significant linear scan overhead and garbage collection pressure on static dictionaries. Pre-building a module-scoped `Map<string, string>` mapping lowercased keys and labels to canonical IDs turns linear scans into $O(1)$ hash lookups. Caching static nested category structures at module scope avoids rebuilding object hierarchies on every API call.
**Action:** When validating against static registries or serving static categorization hierarchies, pre-compute a module-scope lookup `Map` and static result arrays at module initialization time.
