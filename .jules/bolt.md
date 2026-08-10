## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [String Normalization and Similarity Pre-computation]
**Learning:** Normalization checks inside hot-path similarity loops are expensive because they perform regex matches and string operations repeatedly. An `isNormalized` character-code fast path avoids regex and string manipulation entirely for pre-normalized inputs. Pre-compiling token-checking regexes (`TITLE_CREDENTIAL_RE`) avoids expensive array splits, filters, and joins when no titles/credentials exist.
**Action:** Always implement an `isNormalized` fast path for string normalizers and extract pre-normalized variants of similarity functions (`similarityNamePreNormalized`) to hoist normalizations out of loop invariants.
