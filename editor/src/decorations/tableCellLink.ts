// `[[` completion INSIDE a table cell (owner, 2026-11-10).
//
// # Why this is a module of its own
//
// An editable table cell is not CodeMirror content. `TableWidget.beginEdit` swaps
// the rendered cell for a plain single-line `<input>` (`decorations/table.ts`),
// so the `[[` picker — a CodeMirror ViewPlugin keyed on the document and its own
// tooltip — never runs there. The cell accepted brackets and nothing else: a
// writer had to know the exact title, with no search, no path and no alias. That
// is the bug this file closes.
//
// # Nothing here re-implements the picker
//
// The candidates, their ranking and the emitted bytes are the picker's own:
// `rankNotes` (`wikilink/picker-rank.ts`) over the note-set facet, and
// `emitNoteWikilink` / `emitFolderWikilink` (`wikilink/emit.ts`). A second ranker
// would rank the same vault differently in a cell and in a paragraph, and a second
// emitter would write a DIFFERENT SPELLING of the same link into the same note.
//
// # What is different, and why it must be
//
// The picker authors inside a document: it tracks `[[` offsets and rewrites a
// range. A cell input has a value and a caret, so the trigger is found by scanning
// the value backwards from the caret, and the replacement is a string splice. The
// popup is a plain `div` positioned with `position: fixed` against the input's
// rect — the table lives in a `contain: inline-size` scroll box, so anything
// anchored inside it would be clipped at the cell's edge.

import { readNoteSet } from "../wikilink/note-set";
import { readRecentNotes } from "../wikilink/recent-notes";
import { rankNotes, type PickerRow } from "../wikilink/picker-rank";
import { emitFolderWikilink, emitNoteWikilink } from "../wikilink/emit";
import type { EditorView } from "@codemirror/view";

/** How many rows the cell popup offers. The picker's 50 is a scrollable list with
 *  a description column; this one hangs under a single table cell, where more than
 *  a handful is unreadable AND unusable on a phone. */
export const CELL_SUGGEST_CAP = 8;

/**
 * The in-progress link under the caret, or `null`.
 *
 * `from` is the index of the first `[` of the OPENING `[[`; `query` is what has
 * been typed since. A link that is already closed (`[[X]]`) is not in progress —
 * the caret is past its `]]` — so completion does not re-open on a finished link.
 * A `|` or `#` also ends the note-name half: those are the alias and heading
 * halves, and the picker has separate modes for them which a cell input does not
 * offer.
 */
export function activeCellLink(
  value: string,
  caret: number,
): { from: number; query: string } | null {
  const before = value.slice(0, caret);
  const open = before.lastIndexOf("[[");
  if (open < 0) return null;
  const query = before.slice(open + 2);
  // A closed link, a newline, or a second `[[` inside the query: not authoring.
  if (query.includes("]]") || query.includes("[") || query.includes("|") || query.includes("#")) {
    return null;
  }
  return { from: open, query };
}

/** The bytes a row inserts — the picker's own emitter, never a second spelling. */
export function cellSuggestionText(row: PickerRow): string {
  return row.kind === "folder"
    ? emitFolderWikilink(row.path)
    : emitNoteWikilink(row.note.folder, row.note.title ?? "");
}

/** A row's label: the title for a note, the trailing-slash path for a folder. */
function cellSuggestionLabel(row: PickerRow): string {
  return row.kind === "folder" ? row.path : (row.note.title ?? row.path);
}

/** The secondary line a row shows: the note's vault path, or nothing for a folder. */
function cellSuggestionDetail(row: PickerRow): string | null {
  return row.kind === "folder" ? null : row.path;
}

/** Rank this cell's candidates through the picker's own scoring. */
export function cellSuggestions(
  query: string,
  notes: Parameters<typeof rankNotes>[1],
  recent: readonly string[],
  cap: number = CELL_SUGGEST_CAP,
): PickerRow[] {
  return rankNotes(query, notes, recent, cap);
}

/** Splice the accepted link over the in-progress one; returns the new value and caret. */
export function applyCellSuggestion(
  value: string,
  link: { from: number; query: string },
  text: string,
): { value: string; caret: number } {
  const head = value.slice(0, link.from);
  const tail = value.slice(link.from + 2 + link.query.length);
  return { value: `${head}${text}${tail}`, caret: head.length + text.length };
}

export type CellLinkSuggest = {
  /** True while the popup is open, so the cell's keydown handler yields to it. */
  isOpen: () => boolean;
  /** Keys the popup consumes. Returns true when it handled the event. */
  handleKey: (event: KeyboardEvent) => boolean;
  /** Recompute from the input's current value + caret (call on input/click). */
  refresh: () => void;
  /** Remove the popup and its listeners. */
  destroy: () => void;
};

/**
 * Attach the popup to a cell input.
 *
 * `onChanged` runs after an acceptance so the caller can keep whatever mirror of
 * the value it holds in step; the cell's own commit stays on blur, exactly as it
 * did before the popup existed.
 */
export function attachCellLinkSuggest(
  input: HTMLInputElement,
  view: EditorView,
  onChanged?: () => void,
): CellLinkSuggest {
  const doc = input.ownerDocument;
  const popup = doc.createElement("div");
  popup.className = "cm-table-link-suggest";
  popup.setAttribute("role", "listbox");
  popup.style.display = "none";
  doc.body.appendChild(popup);

  let rows: PickerRow[] = [];
  let active = 0;
  let link: { from: number; query: string } | null = null;

  const close = (): void => {
    rows = [];
    link = null;
    popup.style.display = "none";
    popup.replaceChildren();
  };

  const paint = (): void => {
    popup.replaceChildren();
    rows.forEach((row, index) => {
      const option = doc.createElement("div");
      option.className = "cm-table-link-suggest-row";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === active));
      if (index === active) option.dataset.active = "true";
      const label = doc.createElement("span");
      label.className = "cm-table-link-suggest-label";
      label.textContent = cellSuggestionLabel(row);
      option.appendChild(label);
      const detail = cellSuggestionDetail(row);
      if (detail !== null && detail !== "") {
        const sub = doc.createElement("span");
        sub.className = "cm-table-link-suggest-detail";
        sub.textContent = detail;
        option.appendChild(sub);
      }
      // `mousedown`, not `click`: the input blurs on mousedown, which commits the
      // cell and destroys this popup before a click could land.
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        accept(index);
      });
      popup.appendChild(option);
    });
  };

  const place = (): void => {
    const rect = input.getBoundingClientRect();
    popup.style.left = `${Math.round(rect.left)}px`;
    popup.style.top = `${Math.round(rect.bottom + 4)}px`;
    popup.style.minWidth = `${Math.round(rect.width)}px`;
  };

  const accept = (index: number): void => {
    const row = rows[index];
    if (row === undefined || link === null) return;
    const next = applyCellSuggestion(input.value, link, cellSuggestionText(row));
    input.value = next.value;
    input.setSelectionRange(next.caret, next.caret);
    close();
    onChanged?.();
    // The commit is still the cell's own (blur / Enter): accepting a link must not
    // end the edit, so the writer can keep typing the sentence around it.
    input.focus();
  };

  const refresh = (): void => {
    const caret = input.selectionStart ?? input.value.length;
    const current = activeCellLink(input.value, caret);
    if (current === null) {
      close();
      return;
    }
    const candidates = cellSuggestions(
      current.query,
      readNoteSet(view.state),
      readRecentNotes(view.state),
    );
    link = current;
    rows = candidates;
    active = 0;
    if (candidates.length === 0) {
      close();
      return;
    }
    place();
    paint();
    popup.style.display = "block";
  };

  const handleKey = (event: KeyboardEvent): boolean => {
    if (popup.style.display === "none" || rows.length === 0) return false;
    switch (event.key) {
      case "ArrowDown":
        active = (active + 1) % rows.length;
        paint();
        return true;
      case "ArrowUp":
        active = (active - 1 + rows.length) % rows.length;
        paint();
        return true;
      case "Enter":
      case "Tab":
        // Enter is the cell's COMMIT and Tab its navigate key. While a suggestion
        // is offered, the writer is choosing a link, so both accept first — the
        // second press does what it always did.
        accept(active);
        return true;
      case "Escape":
        // One press closes the popup; the next one cancels the edit, which is the
        // cell's own Escape behaviour.
        close();
        return true;
      default:
        return false;
    }
  };

  input.addEventListener("input", refresh);
  input.addEventListener("click", refresh);
  input.addEventListener("keyup", (event) => {
    // Caret moves change what `[[` is in progress; the keydown above already
    // consumed the keys the popup owns, so this only re-reads the value.
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      refresh();
    }
  });

  return {
    isOpen: () => popup.style.display !== "none",
    handleKey,
    refresh,
    destroy: () => {
      close();
      popup.remove();
    },
  };
}
