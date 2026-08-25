## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Static Map Hoisting and Set Lookups in Intake Engines]
**Learning:** Hot paths in intake engines (like `taxonomy-engine.ts`, `conflict-engine.ts`, and `decision-engine.ts`) often perform redundant `Object.entries()`, array `.map()`, and string `.toLowerCase()` calls on static lookup tables inside inner loops. Converting array lookups to `Set<string>` gives $O(1)$ set membership checks, and pre-computing lowercased map entries at module scope completely avoids GC allocations during lead evaluation.
**Action:** Pre-compute lowercased lookup maps, hoist static RegExp objects and helper closures, and use `Set<string>` for categorical lookups in hot validation paths.
