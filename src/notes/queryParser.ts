// Re-export shim: the search query-language parser (MYND-303 field operators +
// MYND-307 boolean/phrase) lives in the shared `@myne/editor` package
// (`host/notes/queryParser`) so every client compiles the IDENTICAL grammar and
// FilterNode mapping — one parser, no drift. Desktop importers keep importing
// `src/notes/queryParser`; the shim preserves both the path and type identity.
export * from "@myne/editor/host/notes/queryParser";
