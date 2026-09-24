## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Email Validation Hoisting & Fast Paths]
**Learning:** Instantiating `RegExp` arrays and performing `.includes()` array lookups inside hot validation paths creates high allocation rate and GC overhead. Early `.endsWith(".com")` checks bypass malformed TLD loops and TLD slicing for ~95%+ of standard email addresses.
**Action:** Always hoist static regex arrays and sets to module scope. Check domain suffix fast paths before iterating over negative condition list loops.
