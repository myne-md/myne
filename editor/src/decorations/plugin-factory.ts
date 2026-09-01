// Shared CM6 ViewPlugin factory for decoration extensions.
//
// All decoration files in this directory follow the same scaffold: a pure
// `build(view) -> DecorationSet` builder + a ViewPlugin that calls it on
// the relevant update signals. Extract the scaffold so each decoration
// file only owns its own builder.

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  editorFocusChanged,
  editorFocusField,
  editorFocusTracker,
} from "./cursor-aware";
import { subscribeDateTimeDisplay } from "@myne/editor/host/lib/datetimeFormat";

/** True when background parsing advanced the tree between the two states —
 *  the tree is reference-stable, so inequality means a reparse landed. Without
 *  this, syntax-driven decorations go stale on notes longer than the viewport:
 *  the rebuild on `docChanged` can run before the incremental parser re-covers
 *  the edited region, so e.g. a toggled task checkbox renders as raw text until
 *  the next interaction. (CM6 "Decorating Syntax" recipe.) */
export const treeChanged = (update: ViewUpdate): boolean =>
  syntaxTree(update.startState) !== syntaxTree(update.state);

/**
 * A label this editor draws depends on AMBIENT state that no transaction
 * carries: the reader's date and time format, and the interface language
 * (myne-md/myne#609).
 *
 * Both are read at BUILD time by the decoration that needs them, which is the
 * right place for them, and neither changes the document, the viewport, the
 * selection or the focus. So without this effect the default gate below never
 * fires and the label keeps whatever it was built with. `callout.ts` records
 * exactly that outcome and accepts it: "a switched language re-labels on the
 * next rebuild (any edit, scroll or selection move). It isn't wired." This is
 * the wiring, and it is deliberately in the SHARED gate rather than in one
 * decoration's own, because at least three families read ambient state (task
 * chips, recurrence labels, callout titles) and a per-decoration channel would
 * have to be remembered by the fourth.
 */
export const ambientLabelsChanged = StateEffect.define<null>();

/** Default update trigger: doc / viewport / selection / focus / parse changes,
 *  plus an ambient-label refresh, used by every cursor-aware decoration
 *  (emphasis, link, inline-code, heading, blockquote, hr, frontmatter). */
const cursorAwareUpdate = (update: ViewUpdate): boolean =>
  update.docChanged ||
  update.viewportChanged ||
  update.selectionSet ||
  update.focusChanged ||
  treeChanged(update) ||
  update.transactions.some((tr) =>
    tr.effects.some((e) => e.is(ambientLabelsChanged)),
  );

/**
 * Turns a display-settings change into the effect above. Mounted once per
 * editor in `extensions.ts`, NOT inside `myneDecorations()`: that array lives
 * in the view-mode compartment, which `source` mode empties and every mode
 * switch rebuilds, so a subscription there would churn on each toggle and be
 * absent in source mode.
 *
 * A subscription rather than a prop, because the display settings already live
 * in a shared store that all three clients read, so one subscription here covers
 * the desktop, the web and the mobile mounts. Threading a prop would mean the
 * same wiring twice, in two client trees, with nothing to catch the second one
 * being forgotten. That is precisely the shape myne-md/myne#609 was filed for:
 * one publisher, three readers, and no gate that could see the asymmetry.
 *
 * **The interface language rides this same channel and needs no listener of its
 * own.** `DateTimeDisplay` carries `locale`, the host adapter republishes when
 * the app language changes, and `setDateTimeDisplay` compares `locale` among the
 * four fields it diffs. So a language switch reaches here as an ordinary store
 * change. That matters beyond tidiness: a second subscription would have to go
 * through the `EditorHost` seam, since this package deliberately sees only `t`,
 * and a new seam method costs every implementation plus the seam contract, for a
 * signal the store already carries.
 *
 * The handle is released in `destroy()`. A listener that survives its view
 * dispatches into a destroyed editor on the next settings change.
 */
export function ambientLabelRefresh(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly release: () => void;

      constructor(view: EditorView) {
        this.release = subscribeDateTimeDisplay(() => {
          view.dispatch({ effects: ambientLabelsChanged.of(null) });
        });
      }

      destroy(): void {
        this.release();
      }
    },
  );
}

export function makeCursorAwareDecorationPlugin(
  build: (view: EditorView) => DecorationSet,
): Extension {
  return makeDecorationPlugin(build, cursorAwareUpdate);
}

/**
 * Like {@link makeCursorAwareDecorationPlugin} but with a caller-supplied
 * recompute trigger, for a decoration whose reveal depends on state the default
 * gate does not watch. MYND-614's task chips need this: their reveal is driven
 * by the find panel, and `openSearchPanel` dispatches a StateEffect that changes
 * neither the doc, the viewport, the selection, nor focus — so the default gate
 * never fires and the chips would stay rendered over a search match.
 */
export function makeGatedDecorationPlugin(
  build: (view: EditorView) => DecorationSet,
  shouldUpdate: (update: ViewUpdate) => boolean,
): Extension {
  return makeDecorationPlugin(
    build,
    (update) => cursorAwareUpdate(update) || shouldUpdate(update),
  );
}

/**
 * StateField analog of `makeCursorAwareDecorationPlugin`, for decorations that
 * CM6 forbids from a ViewPlugin — block-replace or any replace crossing a line
 * break (setext underline collapse, reference-definition-line collapse, the
 * table widget). Owns the recompute gate (doc / selection / focus / parse), the
 * `provide`, and — crucially — bundles the shared `editorFocusField` + tracker
 * BEFORE the decoration field so `linesRevealed`/focus reads are current. Pass a
 * pure `build(state) -> DecorationSet`. Returns the extension trio (the focus
 * field/tracker dedup by identity when several decorators include them).
 */
export function makeCursorAwareStateField(
  build: (state: EditorState) => DecorationSet,
): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return build(state);
    },
    update(decorations, tr) {
      const selectionChanged = !tr.startState.selection.eq(tr.state.selection);
      const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
      // The ambient clause belongs here too, and leaving it out would defeat the
      // reason it went into the shared gate at all (myne-md/myne#609). This
      // scaffold's users are the decorations CodeMirror FORBIDS from a
      // ViewPlugin, so the fourth family that wants an ambient label and lands
      // on this path would silently get the pre-#609 behaviour: exactly the
      // "somebody will forget" case the shared gate exists for, one scaffold
      // over. None of today's users draws one, so this is latent rather than a
      // fix, and it is here so it stays that way.
      const ambient = tr.effects.some((e) => e.is(ambientLabelsChanged));
      if (
        !tr.docChanged &&
        !selectionChanged &&
        !editorFocusChanged(tr) &&
        !ambient &&
        !treeChanged
      ) {
        return decorations;
      }
      return build(tr.state);
    },
    provide(f) {
      return EditorView.decorations.from(f);
    },
  });
  return [editorFocusField, editorFocusTracker, field];
}

function makeDecorationPlugin(
  build: (view: EditorView) => DecorationSet,
  shouldUpdate: (update: ViewUpdate) => boolean,
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (shouldUpdate(update)) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
