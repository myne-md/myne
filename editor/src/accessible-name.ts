// The editor body's accessible name (myne-md/myne#728, task 4).
//
// CodeMirror's content element is a `contenteditable` with `role="textbox"`,
// and it had no name. axe reports that as `aria-input-field-name` (it was one of
// the four ids in the E2E baseline); a screen-reader user reaches the largest
// control in the application and is told "edit text", with nothing saying which
// note they are in. In a split, where two of these are on screen at once, that
// is the difference between two editors and two indistinguishable ones.
//
// The name is built HERE rather than by each host, from the note TITLE the host
// supplies, because the label's wording is a property of the editor surface and
// three clients render this same surface. A host that passes nothing gets the
// untitled wording rather than no name at all: an anonymous textbox is the
// defect, and "a note whose title we do not know" is still a better answer.
//
// Same five-part shape as `note-identity.ts`: facet, compartment, seed, read,
// reconfigure. A Compartment because the desktop shell keeps ONE long-lived
// view per pane and swaps documents (and titles) through it, so the name has to
// be reconfigurable without a remount - a renamed note must not keep announcing
// its old name until the pane is rebuilt.

import {
  Compartment,
  type EditorState,
  Facet,
  type Extension,
  type StateEffect,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import i18n from "./i18n";

/** The title of the note this view holds, or `null` when the host has not said. */
export const editorTitleFacet = Facet.define<string | null, string | null>({
  combine: (values) => (values.length > 0 ? values[values.length - 1]! : null),
});

const titleCompartment = new Compartment();

/**
 * The name announced for the editor body. Exported so the label rule has one
 * definition and a test can assert it without rendering CodeMirror.
 *
 * A blank or whitespace-only title is the untitled case, not a name: an
 * `aria-label=""` is treated as no label at all, which puts the surface back
 * where it started.
 */
export function editorAccessibleName(title: string | null): string {
  const trimmed = title?.trim() ?? "";
  return trimmed === ""
    ? i18n.t("editor.a11y.untitledNoteBody")
    : i18n.t("editor.a11y.noteBody", { title: trimmed });
}

/**
 * Compose into `myneExtensions()`. Installing the raw facet instead would make
 * every later `reconfigureEditorTitle` a silent no-op, the one way this wiring
 * type-checks and does nothing.
 */
export function editorAccessibleNameExtension(title: string | null = null): Extension {
  return titleCompartment.of(titleExtension(title));
}

function titleExtension(title: string | null): Extension {
  return [
    editorTitleFacet.of(title),
    EditorView.contentAttributes.of({ "aria-label": editorAccessibleName(title) }),
  ];
}

/** Read the title this view was told about. */
export function readEditorTitle(state: EditorState): string | null {
  return state.facet(editorTitleFacet);
}

/** The effect the host dispatches when the pane's note, or its title, changes. */
export function reconfigureEditorTitle(title: string | null): StateEffect<unknown> {
  return titleCompartment.reconfigure(titleExtension(title));
}
