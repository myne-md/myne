// @myne/editor — shared CodeMirror editor engine (public surface).
// Consumers import the mount component + extension composer + the host seam.
export { CMEditor } from "./CMEditor";
export type { CMEditorProps } from "./CMEditor";
export { myneExtensions } from "./extensions";
export { setEditorHost, getHost } from "./host";
export type { EditorHost, EditorPrefs, TagTreeNode, SpellWord } from "./host";
export type { ResolverNote } from "./host/notes/resolveWikilink";
