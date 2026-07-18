## 2025-05-15 - [String Similarity Optimization]
**Learning:** Redundant normalization in fuzzy matching functions (calling `normalize()` multiple times on the same input) is a significant bottleneck. Standard `Array<number>` for Levenshtein distance creates GC pressure and is slower than `Int32Array`. String swapping ensures the auxiliary array is as small as possible.
**Action:** Use `Int32Array` and single-vector DP approach for Levenshtein. Always reuse normalized strings instead of re-normalizing in wrapper functions. Add early returns for near-exact matches to skip expensive fuzzy logic.

## 2025-05-16 - [Sanitizing Database/ORM Errors to Prevent Credential Leaks]
**Learning:** ORM/Database libraries like Drizzle-ORM often format raw SQL query parameters (which can contain high-entropy secrets, plaintext tokens, or personal identifiers) directly into `Error.message` when a query fails. Thus, simply logging `err` or `err.message` inside `catch` blocks can inadvertently leak critical credentials to application logs.
**Action:** Never log raw database errors on tables/columns processing sensitive data. Check and sanitize any error message strings containing "Failed query" or any reference to the secret before outputting to logs.
