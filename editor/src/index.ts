// @myne/editor — shared CodeMirror editor engine (public surface).
// Consumers import the mount component + extension composer + the host seam.
export { CMEditor } from "./CMEditor";
export type { CMEditorProps } from "./CMEditor";
export { myneExtensions } from "./extensions";
// Shared formatting commands — the single source used by the desktop selection
// toolbar, the keymap, AND a host-supplied accessory bar (mobile keyboard bar).
export { editorCommands } from "./toolbar/commands";
export type { ToolbarCommand, EditorCommandId } from "./toolbar/commands";
export { setEditorHost, getHost } from "./host";
export type { EditorHost, EditorPrefs, TagTreeNode, SpellWord } from "./host";
export type { ResolverNote } from "./host/notes/resolveWikilink";
