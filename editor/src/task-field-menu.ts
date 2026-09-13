// Add-a-task-field entry points: the `+` affordance's mini-menu and the shared
// opener both the menu and the `/due` `/remind` `/repeat` `/priority` slash
// commands call.
//
// The whole point is that NONE of the write machinery is new. A chip click today
// goes begin-track → open-editor → apply-edit (`task-chip-listener.ts`), and
// adding a field is the SAME path with two differences: the value starts empty,
// and the tracked span is anchored to the caret's task line instead of an
// existing chip's range. `applyTaskFieldEdit` already appends a missing field at
// line end (it reads `parseTaskFields`, sets the one kind, and lets
// `planTaskFieldWrite` serialize), so "add" and "edit" are one function — which
// is exactly why this file emits no task-field bytes of its own and the
// single-writer grep stays clean.
//
// Surfaces mount to `document.body` via `openModal`, outside `.cm-editor`, so
// their chrome (`.cm-task-field-menu`) lives in `task-surfaces.css`. It is not
// imported here directly: importing `./task-field-editor` below pulls that
// module in, and its own top-level `import "./task-surfaces.css"` loads the
// stylesheet the moment this file is evaluated — before the menu can render.

import { EditorView } from "@codemirror/view";
import { openModal } from "./host/lib/imperative-modal";
import { computePosition, type Rect } from "./positioning";
import { openTaskFieldEditor, type TaskFieldKind } from "./task-field-editor";
import {
  applyTaskFieldEdit,
  beginTaskFieldEdit,
  chipRangesIn,
  type TaskFieldEditHandle,
} from "./decorations/task-chip";
import { canSkipOccurrence, skipOccurrence } from "./decorations/task-recurrence";
import { canRecur } from "@myne/dialect/taskRecurrence";
import i18n from "@myne/editor/i18n";

/** Menu order — the same stable order the writer serializes in. */
const MENU_KINDS: readonly TaskFieldKind[] = ["due", "remind", "repeat", "priority"];

/**
 * Open the field editor to ADD (or, if the line already carries this kind, EDIT)
 * one task field on the caret's task line.
 *
 * The tracked span is the whole line, mapped through document changes for as
 * long as the editor is open — the identical protection a chip edit needs
 * (`task-chip.ts`'s pending-chip field), because a background autosave rewrites
 * the frontmatter stamp about a second after any edit and would otherwise shift
 * the line out from under the commit. If the line is deleted while the editor is
 * open, `current()` goes null and the write declines rather than guessing.
 */
export function openTaskFieldAdd(
  view: EditorView,
  lineFrom: number,
  kind: TaskFieldKind,
  anchor: HTMLElement | Rect,
  opts?: { handle?: TaskFieldEditHandle; onEditorClose?: () => void },
): void {
  const line = view.state.doc.lineAt(lineFrom);
  // Prefill from the existing field, if any, so choosing a present kind edits it
  // instead of clobbering it. `chipRangesIn` yields the SOURCE value (never the
  // localized chip label), which is exactly what the editor prefills and a
  // commit writes back.
  const existing = chipRangesIn(view.state, line.from, line.to).find(
    (span) => span.kind === kind,
  );
  // The menu opens this editor while a tracked span is ALREADY live, so the
  // editor BORROWS that handle rather than minting a second one: exactly one
  // span is mapped through document changes for as long as either surface is
  // open. A borrowed handle is never ended here — the menu owns its lifetime.
  const borrowed = opts?.handle;
  const edit = borrowed ?? beginTaskFieldEdit(view, { from: line.from, to: line.to, kind });
  openTaskFieldEditor({
    anchor,
    kind,
    value: existing?.value ?? "",
    onCommit: (next) => {
      const span = edit.current();
      if (borrowed === undefined) edit.end();
      // Null means the line was deleted while the editor was open — declining is
      // the only correct answer (mirrors the chip listener).
      if (span === null) {
        opts?.onEditorClose?.();
        return;
      }
      // A borrowed handle was created with kind `repeat` (the menu tracks the
      // whole line, not one field), so the field actually being written
      // overrides it.
      if (!applyTaskFieldEdit(view, borrowed === undefined ? span : { ...span, kind }, next)) {
        opts?.onEditorClose?.();
        return;
      }
      // myne#276: a `repeat` with nothing to repeat FROM is inert by
      // construction, and the menu let you mint one with no warning of any
      // kind. Rather than refuse the write — the rule the user typed is
      // correct, and refusing it would discard it — offer the anchor it needs,
      // in the same surface, immediately. Declining leaves the rule on the line
      // with its inline explanation (`task-chip.ts`), so nothing is lost either
      // way.
      if (kind !== "repeat" || next === "") {
        opts?.onEditorClose?.();
        return;
      }
      // Re-read the line from the post-write document. Clamped, because a
      // document that shrank under a concurrent change must not throw here —
      // an offer of a due date is not worth an exception on the save path.
      const written = view.state.doc.lineAt(
        Math.min(span.from, view.state.doc.length),
      );
      if (canRecur(written.text)) {
        opts?.onEditorClose?.();
        return;
      }
      // The chained due editor borrows the SAME handle, so its own close is what
      // finally reports the editor as closed — not this repeat one, which has
      // already handed off.
      openTaskFieldAdd(view, written.from, "due", anchor, opts);
    },
    onCancel: () => {
      if (borrowed === undefined) edit.end();
      opts?.onEditorClose?.();
    },
  });
}

/**
 * Open the "add field" mini-menu anchored to the `+` affordance.
 *
 * A kind the line already carries is relabelled "Edit …" and routes through the
 * same opener (which prefills it) — strictly more useful than hiding it, and it
 * reuses the seam. The menu is an anchored popover, not a blocking dialog, so it
 * uses the transparent-backdrop `openModal` shape `task-field-editor.ts` uses,
 * getting focus-trap + Esc + backdrop-click dismissal for free.
 *
 * A **skip** row joins them when the caret's line carries a recurrence rule
 * that can actually be advanced (myne#198). It sits below a separator because it
 * is categorically different from its neighbours: the other rows open an editor
 * to change a value, this one performs an action and closes. The test for
 * showing it is deliberately "can this occurrence be skipped", not "does this
 * line carry a repeat field" — offering an action that would silently do nothing
 * on an unreadable or anchorless rule is the same failure the chip layer forbids
 * itself in `decorations/task-chip.ts`.
 */
export function openTaskFieldMenu(opts: {
  view: EditorView;
  anchor: HTMLElement;
  lineFrom: number;
}): void {
  const { view, anchor, lineFrom } = opts;
  const line = view.state.doc.lineAt(lineFrom);
  const present = new Set<TaskFieldKind>();
  for (const span of chipRangesIn(view.state, line.from, line.to)) {
    present.add(span.kind);
  }

  // Track the caret's line for as long as the menu is open (myne#326).
  //
  // EVERY row needs this, not just the skip row. A menu is easily open for
  // longer than the ~1 s autosave that rewrites the frontmatter `updated:`
  // stamp, and any growth above the task line moves it forward — so the offset
  // captured at open time lands in the PRECEDING line by the time a row is
  // clicked. Nothing downstream guards it: `planTaskFieldWrite` rewrites
  // whatever line text it is handed, so `[due:: …]` could be appended to an
  // unrelated task, to prose, or to a YAML line inside the frontmatter block,
  // corrupting it. And if the document SHRANK past the captured offset — a
  // shorter remote version arriving — `doc.lineAt` threw a `RangeError` out of
  // the click handler after `modal.close()` had already run, so the menu simply
  // vanished.
  //
  // Tracking has to begin HERE rather than on click: by click time the offsets
  // have already moved. Ended on every exit, so an abandoned menu leaves no
  // tracking behind — EXCEPT while a field editor borrows it: the row handler
  // below hands this handle to the editor and deliberately does not end it, so
  // exactly one tracked span stays live across both surfaces (myne-md/myne#656).
  const tracked: TaskFieldEditHandle = beginTaskFieldEdit(view, {
    from: line.from,
    to: line.to,
    kind: "repeat",
  });

  // True between a row opening the field editor and that editor closing (commit
  // or cancel). While it holds, the menu's own dismiss must do NOTHING: the
  // editor is the innermost trap, its Escape is the one that means "close the
  // editor", and tearing the menu (and therefore the borrowed span) down behind
  // it would end the very handle the editor is still writing through.
  let editorOpen = false;

  const modal = openModal({
    backdropStyle: {
      position: "fixed",
      inset: "0",
      background: "transparent",
      zIndex: "2147483000",
    },
    onDismiss: () => {
      if (editorOpen) return;
      tracked.end();
      modal.close();
    },
  });

  const surface = document.createElement("div");
  surface.className = "cm-task-field-menu";
  surface.setAttribute("role", "menu");
  surface.setAttribute("aria-label", i18n.t("editor.taskField.menuTitle"));
  surface.setAttribute("data-testid", "editor.task-field-menu");
  // Inline position too, not only in the stylesheet: computePosition's left/top
  // are inline and a bare test DOM never applies the imported CSS.
  surface.style.position = "fixed";

  // myne#276: whether picking **Repeat** here would mint an inert rule. The
  // line carries no `due` and no `remind`, so whatever rule the user chooses
  // has nothing to repeat FROM. Say so on the row, before they commit — the
  // previous signal was a `title=` tooltip on the resulting raw text, which
  // requires already knowing where to hover.
  const repeatNeedsAnchor = !present.has("due") && !present.has("remind");

  let firstRow: HTMLButtonElement | null = null;
  for (const kind of MENU_KINDS) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cm-task-field-menu-row";
    row.setAttribute("role", "menuitem");
    row.setAttribute("data-testid", `editor.task-field-menu-${kind}`);
    const title = i18n.t(`editor.taskField.title.${kind}`);
    const label = document.createElement("span");
    label.textContent = present.has(kind)
      ? i18n.t("editor.taskField.menuEdit", { field: title })
      : title;
    row.appendChild(label);
    if (kind === "repeat" && repeatNeedsAnchor) {
      const note = document.createElement("span");
      note.className = "cm-task-field-menu-note";
      note.setAttribute("data-testid", "editor.task-field-menu-repeat-note");
      note.textContent = i18n.t("editor.taskField.repeatNeedsDate");
      row.appendChild(note);
    }
    row.addEventListener("click", () => {
      // Capture the row's live rect — the field editor anchors to where the row
      // is, and the menu stays mounted so the row is still here.
      const rect = row.getBoundingClientRect();
      // The line as it stands NOW, not as it stood when the menu opened
      // (myne#326). Null means the line was deleted while the menu was open, and
      // declining is the only correct answer — the same rule the skip row and
      // the field editor already follow.
      const span = tracked.current();
      if (span === null) {
        tracked.end();
        modal.close();
        return;
      }
      // Hand the menu's ONE tracked handle to the editor and keep it live: the
      // editor borrows it instead of minting a second, so the span keeps mapping
      // through document changes on both sides of the handoff. The editor's
      // close flips `editorOpen` back so the next Escape reaches the menu.
      editorOpen = true;
      openTaskFieldAdd(view, span.from, kind, rect, {
        handle: tracked,
        onEditorClose: () => {
          editorOpen = false;
        },
      });
    });
    if (firstRow === null) firstRow = row;
    surface.appendChild(row);
  }

  if (canSkipOccurrence(line.text)) {
    const separator = document.createElement("div");
    separator.className = "cm-task-field-menu-sep";
    separator.setAttribute("role", "separator");
    surface.appendChild(separator);

    const row = document.createElement("button");
    row.type = "button";
    row.className = "cm-task-field-menu-row";
    row.setAttribute("role", "menuitem");
    row.setAttribute("data-testid", "editor.task-field-menu-skip");
    row.textContent = i18n.t("editor.taskField.skipOccurrence");
    row.addEventListener("click", () => {
      const span = tracked.current();
      tracked.end();
      modal.close();
      if (span !== null) skipOccurrence(view, span.from);
    });
    if (firstRow === null) firstRow = row;
    surface.appendChild(row);
  }

  modal.backdrop.appendChild(surface);

  // Position after mounting so the surface has measurable dimensions.
  const rect = anchor.getBoundingClientRect();
  const placed = computePosition({
    anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    surfaceWidth: surface.offsetWidth || 200,
    surfaceHeight: surface.offsetHeight || 120,
    preferredPlacement: "below",
  });
  surface.style.left = `${placed.left}px`;
  surface.style.top = `${placed.top}px`;

  modal.installTrap(surface, firstRow);
}
