## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Fuzzy Match Optimization and Fast-Path Routing]
**Learning:** Even with an optimized Levenshtein implementation, the overhead of regex compilation, string splitting/filtering/joining, and full DP matrix computations is substantial on cold/clean inputs. By routing typical inputs through lightweight "fast-paths" (like scanning character codes to verify normalization and testing token regexes before splitting), we can completely bypass expensive string allocations and DP loops.
**Action:** Always implement fast-paths that check for already-clean or trivial conditions using fast non-allocating loops/regex tests before falling back to full-blown parsing or fuzzy algorithms.

## 2026-06-04 - [Workspace Build Failure from Strict Runtime Port Check]
**Learning:** Monorepos built by remote platforms (like Cloudflare Workers, Pages, or global CI pipelines) often run recursive build commands like `pnpm build` across all workspace packages. If any package (even an unused mockup sandbox) strictly throws errors for missing runtime-only environment variables (like `PORT` or `BASE_PATH`) during its configuration load, it will crash the entire workspace build and fail the CI.
**Action:** Never throw hard errors for missing server runtime variables inside compiler/bundler configurations (like `vite.config.ts` or `next.config.js`). Always provide sensible static defaults so compiling/building the codebase can succeed cleanly in headless/CI environments.
