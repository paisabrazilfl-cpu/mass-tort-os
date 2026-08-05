## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2026-06-04 - [NPI Provider Search Results Normalization Hoisting]
**Learning:** Normalizing expected target fields over and over inside hot loops of search result candidate scoring (such as in `pickBestSearchResult`) creates massive, redundant string manipulation and regex engine overhead. Additionally, normalizing the same candidate field multiple times for different sub-scorers (e.g., name vs organization) causes redundant GC pressure.
**Action:** Hoist target/expected field normalizations out of result scoring loops. Inside loops, normalize candidate result attributes exactly once, and expose pre-normalized matching APIs (`similarityPreNormalized` and `similarityNamePreNormalized`) to perform matches without redundant computations, yielding ~23% faster execution.
