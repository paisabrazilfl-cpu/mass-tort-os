## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [OFAC Treasury SDN Pre-tokenization Optimization]
**Learning:** Performing per-query string normalizations, regex replacements, and `Set` allocations inside a linear search over thousands of records (e.g. 10,000+ SDN entries) creates massive GC pressure and CPU overhead (~19.17ms per lookup). Pre-tokenizing entity names and AKAs into `Set<string>` structures attached to the snapshot reduces lookup time to ~0.47ms (a ~40.6x speedup).
**Action:** When performing linear string/token matching over large cached reference datasets, pre-tokenize and normalize the reference dataset once when loading or refreshing the cache, rather than normalizing during search loop iterations.
