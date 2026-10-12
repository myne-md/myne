// The remote-change dispatch bridge (epic live-collab, `collab-editor-bridge`
// task 7).
//
// A sync pull that merged a peer revision into an OPEN session hands the pane
// body splices (`plugin:live|live_session_take_remote_splices`). The pane
// dispatches them here as ONE multi-range `ChangeSet`. That is the whole job of
// this module, and it is PURE: it touches no host and imports no `@tauri-apps/*`
// module (the platform-seam rule).
//
// This is deliberately one direction only. A LOCAL body edit travels the other
// way: the pane persists the whole re-derived markdown through
// `liveSessionPatchFrontmatter`, and the CRDT layer records it as minimal
// splices. There is no client-side local-splice entry point, so this module
// exports no transaction-to-splice converter: an earlier design had one, and it
// drifted from the Rust applier it duplicated while no caller exercised it.
//
// # Offsets
//
// CodeMirror reports range endpoints in UTF-16 code units over the whole note,
// and the Rust side already clamped the splices it returns to the body span
// (`SYNC-14`: the managed frontmatter is a reserved, non-spliced region). The
// pane therefore maps them straight back onto the view's own coordinate space.

import { ChangeSet, type EditorSelection, type EditorState } from "@codemirror/state";

/** One remote edit: replace the UTF-16 range `[from, to)` with `insert`. */
export interface LocalSplice {
  from: number;
  to: number;
  insert: string;
}

/**
 * Build ONE multi-range CodeMirror `ChangeSet` from a remote splice list. The
 * editor dispatches this directly (`view.dispatch({ changes })`), never through
 * the controlled `value` + `diffDoc` mirror, which would collapse the ranges into
 * one replacement spanning the user's own text.
 */
export function splicesToChanges(splices: readonly LocalSplice[], docLength: number): ChangeSet {
  return ChangeSet.of(
    splices.map((s) => ({ from: s.from, to: s.to, insert: s.insert })),
    docLength,
  );
}

/**
 * The `view.dispatch` spec for a remote change: the multi-range `ChangeSet` plus
 * an explicit caret map. `assoc = 1` places the caret AFTER a remote insertion
 * that lands exactly at it, so the user keeps typing on their side instead of
 * being pushed before the peer's text, the "chosen, not raced" insert-side
 * semantics.
 */
export function remoteDispatchSpec(
  state: EditorState,
  splices: readonly LocalSplice[],
): { changes: ChangeSet; selection: EditorSelection } {
  const changes = splicesToChanges(splices, state.doc.length);
  return { changes, selection: state.selection.map(changes, 1) };
}
