// Re-export shim: the shared saved-view layout helpers (group stream, column
// set, table grid geometry, testids) live in `@myne/editor/host/notes/viewLayout`
// so the desktop table/list/cards renderers and the mobile ones compute an
// IDENTICAL layout. Desktop importers import `./viewLayout`.
export * from "@myne/editor/host/notes/viewLayout";
