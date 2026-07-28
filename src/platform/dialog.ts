// Platform seam — `@tauri-apps/plugin-dialog`.
//
// `open`/`save` are native OS dialogs returning absolute path STRINGS, which
// is the shape the desktop Rust commands consume. A browser file picker
// cannot produce a path (it produces a `File`), so the web implementation of
// this module is where that difference lands — see task 76, which redefines
// the picker result as an opaque picked-file handle. Until that task, this is
// a straight re-export and the desktop path semantics are untouched.

export { open, save, confirm, message, ask } from "@tauri-apps/plugin-dialog";
export type { OpenDialogOptions, SaveDialogOptions } from "@tauri-apps/plugin-dialog";
