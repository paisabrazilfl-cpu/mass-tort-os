## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Levenshtein Prefix/Suffix Trimming Edge Cases]
**Learning:** Prefix and suffix trimming loops in Levenshtein distance are highly effective when comparing strings with common boundaries (yielding ~3x speedups), but introduce a minor micro-overhead for completely non-overlapping inputs. Additionally, name normalisation outputs often have identical strings where reference-equality early exits bypass Levenshtein entirely, making non-overlapping paths a secondary concern.
**Action:** Always implement prefix/suffix trimming but skip string slicing unless a trimming operation actually occurred to completely eliminate substring allocation overhead for non-overlapping cases.
