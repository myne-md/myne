// Re-export shim: the §3.6.4 property type authority now lives in the shared
// `@myne/editor` package (`host/notes/propertyTyping`) so desktop + mobile type
// frontmatter properties identically. Desktop importers keep importing
// `src/notes/propertyTyping`.
export * from "@myne/editor/host/notes/propertyTyping";
