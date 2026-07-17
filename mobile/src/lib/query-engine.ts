// Re-export shim: mobile's former filter-only query engine is retired in favour
// of the SHARED engine (`@myne/editor/host/notes/queryEngine`) — the same
// `runView` / grouping / sort / property-comparison desktop runs, so a saved
// view behaves identically on both clients (no fork, no drift). The old sync
// `evaluateFilter(node, QueryCtx)` API is gone; consumers use the shared async
// `runView` (see `EditorFlow`'s view path).
export * from "@myne/editor/host/notes/queryEngine";
