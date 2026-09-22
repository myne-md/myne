// Announce a fold or unfold (myne-md/myne#728, task 10).
//
// Folding a heading section removes a large part of the document from view.
// Visually that is obvious: the text collapses behind a placeholder. To a
// screen-reader user it is the opposite of obvious, because nothing is said
// and the only evidence is that the content they were about to read is no
// longer there. CodeMirror exposes exactly the mechanism for this
// (`EditorView.announce`, a polite live region the view owns), and the PRD's
// rule is to use it where the engine offers it rather than inventing a second
// live region beside it.
//
// A `transactionExtender` rather than a `ViewPlugin`: the fold state changes in
// the transaction, so appending the announcement to that same transaction
// keeps the announcement and the change atomic. A plugin reacting afterwards
// can fire on a transaction that was later filtered out.
//
// Counted, not per range: `foldAll` dispatches one transaction carrying many
// effects, and one announcement per section would say the same sentence twenty
// times.

import { foldEffect, unfoldEffect } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import i18n from "./i18n";

/**
 * The sentence for a transaction that folded `folded` ranges and unfolded
 * `unfolded` of them, or `null` when it did neither.
 *
 * Exported so the wording rule is testable without a live view, and so the
 * mixed case (a toggle-all that both folds and unfolds) has a stated answer
 * rather than whichever branch happened to come first.
 */
export function foldAnnouncement(folded: number, unfolded: number): string | null {
  if (folded === 0 && unfolded === 0) return null;
  // A mixed transaction is reported by what it mostly did; ties go to folding,
  // because that is the direction that HIDES content and so is the one a
  // reader must be told about.
  if (folded >= unfolded) return i18n.t("editor.a11y.sectionFolded", { count: folded });
  return i18n.t("editor.a11y.sectionUnfolded", { count: unfolded });
}

/** Compose into `myneExtensions()`. */
export function foldAnnounceExtension(): Extension {
  return EditorState.transactionExtender.of((tr) => {
    let folded = 0;
    let unfolded = 0;
    for (const effect of tr.effects) {
      if (effect.is(foldEffect)) folded += 1;
      else if (effect.is(unfoldEffect)) unfolded += 1;
    }
    const message = foldAnnouncement(folded, unfolded);
    return message === null ? null : { effects: EditorView.announce.of(message) };
  });
}
