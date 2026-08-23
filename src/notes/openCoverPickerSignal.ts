// Re-export shim. The transport lives in `@myne/editor/cover-signal`, beside the
// `EditorHost.cover` members it mirrors, because the shape crosses a
// `CustomEvent` and TypeScript checks nothing about that hop: two identical
// copies compiled cleanly while #520 had to add `noteId` to both of them for one
// feature. The shim stays so this client's own import paths keep reading
// locally, which is the same shape `src/editor/` uses for the engine.

export {
  OPEN_COVER_PICKER_EVENT,
  REMOVE_COVER_EVENT,
  type OpenCoverPickerDetail,
  type RemoveCoverDetail,
} from "@myne/editor/cover-signal";
