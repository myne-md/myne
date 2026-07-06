// Re-export shim — the source of truth moved to the shared `@myne/dialect`
// package (Phase A editor/dialect extraction). Desktop importers of
// `../dialect/folderPath` keep resolving through here unchanged; migrate them to
// `@myne/dialect/folderPath` opportunistically.
export * from "@myne/dialect/folderPath";
