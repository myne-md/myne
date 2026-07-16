// Re-export shim: the Saved Views query engine now lives in the shared
// `@myne/editor` package (`host/notes/queryEngine`) so desktop + mobile run the
// IDENTICAL runView / grouping / sort / property-comparison — one implementation,
// no drift. Desktop importers keep importing `src/notes/queryEngine`; the shim
// preserves both the path and the type identity.
export * from "@myne/editor/host/notes/queryEngine";
