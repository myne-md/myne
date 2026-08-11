// Rewrite-selection orchestration (ai-backend-degradation myne#191 task 6).
//
// **Extracted from an arrow function inside `Editor.tsx` so the failure path
// can be tested at all** — which is the point of the task, not a tidy-up. In
// its old shape the whole flow was `void (async () => { … })()` with no
// `.catch`, so an engine rejection became an unhandled promise rejection: no
// toast, no error turn, no document change, nothing in a production build. From
// the user's seat that is indistinguishable from "the model returned the same
// text" and from "the palette action never fired" — and on a stock install,
// where no generation model is side-loaded, it was the outcome EVERY time.
//
// The converged policy this implements: **an explicit user action always
// answers.** A passive surface (ghost text) may stay silent; something the user
// deliberately invoked may not.
//
// The staleness and SYNC-14 fail-closed guards are unchanged in behaviour — the
// folder gate stays at the call site, where the note cache lives, and the
// snapshot/compare guards moved here verbatim.

import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

import { computeRewrite } from "../../lib/writing-assistant";
import { engineErrorTag } from "../../lib/engine-error";

/** Causes that mean *nothing is set up to answer*, as distinct from *it tried
 *  and failed*. Both spellings, because Tauri serializes a unit variant as its
 *  identifier while the `kind()` helper emits snake_case — a mapping that
 *  covers only one of them silently reports the catch-all for the other. */
const NO_PROVIDER: ReadonlySet<string> = new Set([
  "NotReady",
  "not_ready",
  "NoModel",
  "no_model",
  "NoCredential",
  "no_credential",
]);

export interface RewriteToEditorArgs {
  /** The view the action started in; the result is dropped unless this is still
   *  the active one. */
  view: EditorView;
  /** Immutable pre-inference state — a multi-second blocking infer must not
   *  land a stale range onto a document the user edited meanwhile. */
  stateAtStart: EditorState;
  /** The active editor view *now*, re-read after the await. */
  activeView: () => EditorView | null;
  /** Whether the user is still on the note the action started on. */
  stillSameNote: () => boolean;
  infer: (prompt: string) => Promise<string>;
  /** Raise the app's toast. */
  showToast: (message: string) => void;
  /** i18n lookup, injected so this module needs no React context. */
  t: (key: string) => string;
}

/**
 * Rewrite the selection in place, or say why it did not happen.
 *
 * Returns `true` when the document was changed — the tests assert on this AND
 * on the document, so a version that toasted correctly while mutating nothing
 * (or mutating on a failure path) is caught.
 */
export async function rewriteSelectionToEditor(
  args: RewriteToEditorArgs,
): Promise<boolean> {
  let result: Awaited<ReturnType<typeof computeRewrite>>;
  try {
    result = await computeRewrite({ state: args.stateAtStart, infer: args.infer });
  } catch (err) {
    // The one line the old code did not have. The cause is a closed, DENY-safe
    // kind — never a detail string, never any part of the note.
    args.showToast(
      args.t(
        NO_PROVIDER.has(engineErrorTag(err))
          ? "editor.flow.aiRewriteNoProvider"
          : "editor.flow.aiRewriteFailed",
      ),
    );
    return false;
  }
  // A null result or an empty rewrite is not a failure — the pipeline declined
  // (no selection, nothing to do). Silent, as it was.
  if (result === null || result.text.length === 0) return false;

  const original = args.stateAtStart.doc.sliceString(result.from, result.to);
  const now = args.activeView();
  // Staleness guard, verbatim from the call site: same view, same note, and the
  // target range still holds exactly the text we rewrote — otherwise drop the
  // result rather than corrupt the document with pre-inference offsets.
  if (now === null || now !== args.view || !args.stillSameNote()) return false;
  if (result.to > now.state.doc.length) return false;
  if (now.state.doc.sliceString(result.from, result.to) !== original) return false;

  now.dispatch({
    changes: { from: result.from, to: result.to, insert: result.text },
    userEvent: "ai.rewrite",
  });
  return true;
}
