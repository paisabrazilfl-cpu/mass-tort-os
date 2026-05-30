## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [CI Stability and Lockfile Integrity]
**Learning:** Regenerating the root `pnpm-lock.yaml` (e.g., by adding global devDependencies) can cause the 'mtosvelocity' Cloudflare Worker build to fail in CI. This is often because certain workspace projects (like `artifacts/client-portal`) might be missing from the environment or handled specially in the lockfile, and a regeneration breaks the expected CI state.
**Action:** Avoid `pnpm add -w` or any command that modifies the root `pnpm-lock.yaml` unless strictly necessary. If a lockfile change is required, ensure all workspace projects are correctly accounted for.
