// The generated Zod schemas in ./generated/api are the single source of truth.
// Each Zod schema is both a runtime validator AND a type (via `z.infer<typeof X>`),
// so re-exporting the parallel TypeScript declarations from ./generated/types
// would create name collisions (e.g. `CreateLeadBody` exists in both).
// If you need a request/response type, do: `type T = z.infer<typeof CreateLeadBody>`.
export * from "./generated/api";
