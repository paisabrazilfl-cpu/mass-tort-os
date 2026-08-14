## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Fast-Pathing String Normalization & Similarity Checks]
**Learning:** Loop-based character scans (e.g. `isNormalized`) bypass regex compiles, `.toLowerCase()`, and `.trim()` allocations entirely for clean strings. Static RegExp caches (`TITLE_CREDENTIAL_RE`) avoid token split/filter/join arrays. In name-similarity functions, short-circuiting when `strippedA === na && strippedB === nb` completely avoids a second, expensive O(N*M) Levenshtein DP calculation.
**Action:** When working with high-frequency string normalization or similarity checking, always write non-allocating loop checks to short-circuit hot paths for clean inputs. Check for reference equality of transformed/stripped strings to skip redundant fuzzy comparisons.
