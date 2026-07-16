// Re-export shim: the saved-view typed-cell formatter now lives in the shared
// `@myne/editor` package (`host/notes/propertyFormat`) so the desktop + mobile
// table/cards/list renderers paint the IDENTICAL date/pill/checkbox cells (and
// the same `view.prop-*` testids). Desktop importers keep importing
// `src/notes/views/propertyFormat`.
export * from "@myne/editor/host/notes/propertyFormat";
