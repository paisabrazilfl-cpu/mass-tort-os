## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Vite Sandbox Build Fragility]
**Learning:** Sandbox Vite configuration throws hard errors if `PORT` or `BASE_PATH` environment variables are missing during general workspace `pnpm run build` commands. This breaks the automated Cloudflare Workers CI builds, even when those environments only deploy the backend worker and do not run the sandbox preview server.
**Action:** Guard the socket port validation with `process.argv.some((a) => a === "build")` checks to bypass required dev-only parameters during production static builds.
