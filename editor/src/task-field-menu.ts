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
// `planTaskFieldWrite` serialize), so "add" and "edit" are one function - which
// is exactly why this file emits no task-field bytes of its own and the
// single-writer grep stays clean.
//
// Surfaces mount to `document.body` via `openModal`, outside `.cm-editor`, so
// their chrome (`.cm-task-field-menu`) lives in `task-surfaces.css`. It is not
// imported here directly: importing `./task-field-editor` below pulls that
// module in, and its own top-level `import "./task-surfaces.css"` loads the
// stylesheet the moment this file is evaluated - before the menu can render.

import { EditorView } from "@codemirror/view";
import { openModal } from "./host/lib/imperative-modal";
import { computePosition, type Rect } from "./positioning";
import {
  openTaskFieldEditor,
  type TaskFieldEditorHandle,
  type TaskFieldKind,
} from "./task-field-editor";
import {
  applyTaskFieldEdit,
  beginTaskFieldEdit,
  chipRangesIn,
  type TaskFieldEditHandle,
} from "./decorations/task-chip";
import { canSkipOccurrence, skipOccurrence } from "./decorations/task-recurrence";
import { canRecur } from "@myne/dialect/taskRecurrence";
import { taskChipIcon } from "@myne/editor/host/notes/taskChipIcon";
import i18n from "@myne/editor/i18n";

/** Menu order - the same stable order the writer serializes in. */
const MENU_KINDS: readonly TaskFieldKind[] = ["due", "remind", "repeat", "priority"];

/**
 * Open the field editor to ADD (or, if the line already carries this kind, EDIT)
 * one task field on the caret's task line.
 *
 * The tracked span is the whole line, mapped through document changes for as
 * long as the editor is open - the identical protection a chip edit needs
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
  // open. A borrowed handle is never ended here - the menu owns its lifetime.
  const borrowed = opts?.handle;
  const edit = borrowed ?? beginTaskFieldEdit(view, { from: line.from, to: line.to, kind });
  openTaskFieldEditor({
    anchor,
    kind,
    value: existing?.value ?? "",
    onCommit: (next) => {
      const span = edit.current();
      if (borrowed === undefined) edit.end();
      // Null means the line was deleted while the editor was open - declining is
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
      // kind. Rather than refuse the write - the rule the user typed is
      // correct, and refusing it would discard it - offer the anchor it needs,
      // in the same surface, immediately. Declining leaves the rule on the line
      // with its inline explanation (`task-chip.ts`), so nothing is lost either
      // way.
      if (kind !== "repeat" || next === "") {
        opts?.onEditorClose?.();
        return;
      }
      // Re-read the line from the post-write document. Clamped, because a
      // document that shrank under a concurrent change must not throw here -
      // an offer of a due date is not worth an exception on the save path.
      const written = view.state.doc.lineAt(
        Math.min(span.from, view.state.doc.length),
      );
      if (canRecur(written.text)) {
        opts?.onEditorClose?.();
        return;
      }
      // The chained due editor borrows the SAME handle, so its own close is what
      // finally reports the editor as closed - not this repeat one, which has
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
 * same opener (which prefills it) - strictly more useful than hiding it, and it
 * reuses the seam. The menu is an anchored popover, not a blocking dialog, so it
 * uses the transparent-backdrop `openModal` shape `task-field-editor.ts` uses,
 * getting focus-trap + Esc + backdrop-click dismissal for free.
 *
 * A **skip** row joins them when the caret's line carries a recurrence rule
 * that can actually be advanced (myne#198). It sits below a separator because it
 * is categorically different from its neighbours: the other rows open an editor
 * to change a value, this one performs an action and closes. The test for
 * showing it is deliberately "can this occurrence be skipped", not "does this
 * line carry a repeat field" - offering an action that would silently do nothing
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
  // stamp, and any growth above the task line moves it forward - so the offset
  // captured at open time lands in the PRECEDING line by the time a row is
  // clicked. Nothing downstream guards it: `planTaskFieldWrite` rewrites
  // whatever line text it is handed, so `[due:: …]` could be appended to an
  // unrelated task, to prose, or to a YAML line inside the frontmatter block,
  // corrupting it.
  //
  // Tracking has to begin HERE rather than on click: by click time the offsets
  // have already moved. Ended when the MENU closes, since the hosted editor
  // writes through this same handle rather than minting its own.
  const tracked: TaskFieldEditHandle = beginTaskFieldEdit(view, {
    from: line.from,
    to: line.to,
    kind: "repeat",
  });

  // The editor currently mounted in the right pane, if any.
  let activeEditor: TaskFieldEditorHandle | null = null;

  const modal = openModal({
    backdropStyle: {
      position: "fixed",
      inset: "0",
      background: "transparent",
      zIndex: "2147483000",
    },
    onDismiss: () => {
      // Escape peels one layer at a time: an open listbox, then the pane, then
      // the menu itself.
      if (activeEditor !== null) {
        if (activeEditor.escape?.()) return;
        activeEditor.close();
        activeEditor = null;
        renderHint();
        return;
      }
      tracked.end();
      modal.close();
    },
  });

  const surface = document.createElement("div");
  surface.className = "cm-task-field-menu";
  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-label", i18n.t("editor.taskField.menuTitle"));
  surface.setAttribute("data-testid", "editor.task-field-menu");
  // Inline position too, not only in the stylesheet: computePosition's left/top
  // are inline and a bare test DOM never applies the imported CSS.
  surface.style.position = "fixed";

  const list = document.createElement("div");
  list.className = "cm-task-field-menu-list";
  list.setAttribute("role", "menu");
  const pane = document.createElement("div");
  pane.className = "cm-task-field-menu-pane";
  surface.append(list, pane);

  const hint = document.createElement("div");
  hint.className = "cm-task-field-menu-hint";
  hint.setAttribute("data-testid", "editor.task-field-menu-hint");
  hint.textContent = i18n.t("editor.taskField.selectField");
  const renderHint = (): void => {
    pane.replaceChildren(hint);
  };

  // myne#276: whether picking **Repeat** here would mint an inert rule. The
  // line carries no `due` and no `remind`, so whatever rule the user chooses
  // has nothing to repeat FROM. Say so on the row, before they commit.
  const repeatNeedsAnchor = !present.has("due") && !present.has("remind");

  // Open `kind`'s editor in the right pane, mounting it with `host` so the menu
  // owns the backdrop, the trap and the Escape/Enter routing.
  const openKind = (kind: TaskFieldKind): void => {
    // The line as it stands NOW, not as it stood when the menu opened
    // (myne#326). Null means the line was deleted while the menu was open.
    const span = tracked.current();
    if (span === null) {
      tracked.end();
      modal.close();
      return;
    }
    const existing = chipRangesIn(view.state, line.from, line.to).find(
      (s) => s.kind === kind,
    );
    activeEditor?.close();
    activeEditor = openTaskFieldEditor({
      host: pane,
      anchor,
      kind,
      value: existing?.value ?? "",
      onCommit: (next) => {
        activeEditor = null;
        const current = tracked.current();
        if (current === null) {
          renderHint();
          return;
        }
        // The tracked handle was made with kind `repeat`; the field actually
        // being written overrides it.
        if (!applyTaskFieldEdit(view, { ...current, kind }, next)) {
          renderHint();
          return;
        }
        // An anchorless repeat is inert; offer its anchor in the same pane
        // rather than refusing the write (myne#276).
        if (kind === "repeat" && next !== "") {
          const written = view.state.doc.lineAt(
            Math.min(current.from, view.state.doc.length),
          );
          if (!canRecur(written.text)) {
            openKind("due");
            return;
          }
        }
        renderHint();
      },
      onCancel: () => {
        activeEditor = null;
        renderHint();
      },
    });
  };

  let firstRow: HTMLButtonElement | null = null;
  for (const kind of MENU_KINDS) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cm-task-field-menu-row";
    row.setAttribute("role", "menuitem");
    row.setAttribute("data-testid", `editor.task-field-menu-${kind}`);
    const title = i18n.t(`editor.taskField.title.${kind}`);
    // Leading icon, so the menu reads at a glance (myne-md/myne#656 review).
    const main = document.createElement("span");
    main.className = "cm-task-field-menu-main";
    main.appendChild(taskChipIcon(kind, kind === "priority" ? "high" : ""));
    const label = document.createElement("span");
    label.textContent = present.has(kind)
      ? i18n.t("editor.taskField.menuEdit", { field: title })
      : title;
    main.appendChild(label);
    row.appendChild(main);
    if (kind === "repeat" && repeatNeedsAnchor) {
      const note = document.createElement("span");
      note.className = "cm-task-field-menu-note";
      note.setAttribute("data-testid", "editor.task-field-menu-repeat-note");
      note.textContent = i18n.t("editor.taskField.repeatNeedsDate");
      row.appendChild(note);
    }
    row.addEventListener("click", () => openKind(kind));
    if (firstRow === null) firstRow = row;
    list.appendChild(row);
  }

  if (canSkipOccurrence(line.text)) {
    const separator = document.createElement("div");
    separator.className = "cm-task-field-menu-sep";
    separator.setAttribute("role", "separator");
    list.appendChild(separator);

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
    list.appendChild(row);
  }

  renderHint();
  modal.backdrop.appendChild(surface);

  // Position after mounting so the surface has measurable dimensions.
  const rect = anchor.getBoundingClientRect();
  const placed = computePosition({
    anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    surfaceWidth: surface.offsetWidth || 420,
    surfaceHeight: surface.offsetHeight || 200,
    preferredPlacement: "below",
  });
  surface.style.left = `${placed.left}px`;
  surface.style.top = `${placed.top}px`;

  modal.installTrap(surface, firstRow);
}
