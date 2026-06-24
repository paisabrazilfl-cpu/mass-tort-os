## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Cloudflare Worker Build Sensitivity]
**Learning:** The `mtosvelocity` Cloudflare Worker build in CI is extremely sensitive to new files in `artifacts/api-server/src/lib/__tests__/` and `src/lib/__benchmarks__/`. Adding even simple verification tests or benchmarks in these directories can trigger build failures if the bundler attempts to traverse them or if CI exceeds strict file limits.
**Action:** Always verify the worker build locally using `pnpm --filter @workspace/api-server run build` after adding ANY file to the `api-server` package. If CI fails, consider removing verification files before final submission, relying on ephemeral local runs instead.
