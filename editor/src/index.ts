// @myne/editor — shared CodeMirror editor engine (public surface).
// Consumers import the mount component + extension composer + the host seam.
export { CMEditor } from "./CMEditor";
export type { CMEditorProps } from "./CMEditor";
export { myneExtensions } from "./extensions";
// Shared formatting commands — the single source used by the desktop selection
// toolbar, the keymap, AND a host-supplied accessory bar (mobile keyboard bar).
export { editorCommands } from "./toolbar/commands";
export type { ToolbarCommand, EditorCommandId } from "./toolbar/commands";
export { setToolbarLayout } from "./toolbar/plugin";
export { setEditorHost, getHost } from "./host";
export type { EditorHost, EditorPrefs, TagTreeNode, SpellWord } from "./host";
export type { ResolverNote } from "./host/notes/resolveWikilink";
// MYND-382: the enumerate-only imported-block-anchor scanner (the single dialect
// source for `^block-id` markers) — reused by the vault-indices apply path to
// feed the vault-wide `[[^^` picker index.
export { extractBlockAnchors } from "./wikilink/anchor";
export type { BlockAnchor } from "./wikilink/anchor";
