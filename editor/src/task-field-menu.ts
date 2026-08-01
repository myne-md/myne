// Add-a-task-field entry points: the `+` affordance's mini-menu and the shared
// opener both the menu and the `/due` `/repeat` `/priority` slash commands call.
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
} from "./decorations/task-chip";
import i18n from "@myne/editor/i18n";

/** Menu order — the same stable order the writer serializes in. */
const MENU_KINDS: readonly TaskFieldKind[] = ["due", "repeat", "priority"];

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
): void {
  const line = view.state.doc.lineAt(lineFrom);
  // Prefill from the existing field, if any, so choosing a present kind edits it
  // instead of clobbering it. `chipRangesIn` yields the SOURCE value (never the
  // localized chip label), which is exactly what the editor prefills and a
  // commit writes back.
  const existing = chipRangesIn(view.state, line.from, line.to).find(
    (span) => span.kind === kind,
  );
  const edit = beginTaskFieldEdit(view, { from: line.from, to: line.to, kind });
  openTaskFieldEditor({
    anchor,
    kind,
    value: existing?.value ?? "",
    onCommit: (next) => {
      const span = edit.current();
      edit.end();
      // Null means the line was deleted while the editor was open — declining is
      // the only correct answer (mirrors the chip listener).
      if (span !== null) applyTaskFieldEdit(view, span, next);
    },
    onCancel: () => edit.end(),
  });
}

/**
 * Open the three-way "add field" mini-menu anchored to the `+` affordance.
 *
 * A kind the line already carries is relabelled "Edit …" and routes through the
 * same opener (which prefills it) — strictly more useful than hiding it, and it
 * reuses the seam. The menu is an anchored popover, not a blocking dialog, so it
 * uses the transparent-backdrop `openModal` shape `task-field-editor.ts` uses,
 * getting focus-trap + Esc + backdrop-click dismissal for free.
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

  const modal = openModal({
    backdropStyle: {
      position: "fixed",
      inset: "0",
      background: "transparent",
      zIndex: "2147483000",
    },
    onDismiss: () => modal.close(),
  });

  const surface = document.createElement("div");
  surface.className = "cm-task-field-menu";
  surface.setAttribute("role", "menu");
  surface.setAttribute("aria-label", i18n.t("editor.taskField.menuTitle"));
  surface.setAttribute("data-testid", "editor.task-field-menu");
  // Inline position too, not only in the stylesheet: computePosition's left/top
  // are inline and a bare test DOM never applies the imported CSS.
  surface.style.position = "fixed";

  let firstRow: HTMLButtonElement | null = null;
  for (const kind of MENU_KINDS) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cm-task-field-menu-row";
    row.setAttribute("role", "menuitem");
    row.setAttribute("data-testid", `editor.task-field-menu-${kind}`);
    const title = i18n.t(`editor.taskField.title.${kind}`);
    row.textContent = present.has(kind)
      ? i18n.t("editor.taskField.menuEdit", { field: title })
      : title;
    row.addEventListener("click", () => {
      // Capture the row's rect BEFORE close() removes it from the DOM — the
      // field editor anchors to where the row was.
      const rect = row.getBoundingClientRect();
      modal.close();
      openTaskFieldAdd(view, lineFrom, kind, rect);
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
