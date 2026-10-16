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
import { floatingSurfacePresentation } from "./host";
import { createDockedSheet } from "./floating/docked-sheet";
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
 * Continue the wizard once the target's write settles.
 *
 * **A `void` commit runs `onOk` in the SAME TICK**: the editor paths have always
 * re-rendered synchronously and their specs assert it, so only a Promise defers.
 * A refusal lands in `onErr`, which is still a re-read: the surface must show
 * what the line carries rather than what the user tried to write.
 */
function settleCommit(
  result: void | Promise<void>,
  onOk: () => void,
  onErr: () => void,
): void {
  if (!(result instanceof Promise)) {
    onOk();
    return;
  }
  result.then(onOk, onErr);
}

/**
 * Everything a task-field surface needs from whoever OWNS the line, so one
 * component can serve an editor document and a task-list row that has no
 * document behind it at all (myne-md/myne#884 task 8).
 *
 * The menu itself is layout and state; the line is not its business. Both callers
 * answer these four questions, one over a tracked document span and one over a
 * record's raw line, and neither can drift on what a field surface offers.
 */
export type TaskFieldTarget = {
  /** The fields the line carries right now. */
  present: () => ReadonlySet<TaskFieldKind>;
  /** The source value for `kind`, or `""` when the line does not carry it. */
  valueOf: (kind: TaskFieldKind) => string;
  /** The line's text right now, or `null` when the line is gone. */
  lineText: () => string | null;
  /** Write one field. Returns a promise on the list path, which writes a note. */
  commit: (kind: TaskFieldKind, value: string) => void | Promise<void>;
};

/** Open for a caller that has an editor document. */
type TaskFieldMenuFromView = {
  view: EditorView;
  lineFrom: number;
  anchor: HTMLElement | Rect;
  initialKind?: TaskFieldKind;
};

/** Open for a caller that has a record and no document (the task list). */
type TaskFieldMenuFromTask = {
  target: TaskFieldTarget;
  anchor: HTMLElement | Rect;
  initialKind?: TaskFieldKind;
  /** The surface closed. The caller drops whatever it was holding for it. */
  onClose?: () => void;
  /**
   * Optional, and absent for every caller today: advancing a recurrence
   * occurrence is an editor-side mutation (it needs the live document), so the
   * list control offers no skip row. Declared rather than omitted so the two
   * arms of {@link openTaskFieldMenu} stay uniform, and so a caller that ever
   * gains a way to skip has a place to say so.
   */
  onSkip?: () => void;
};

export type TaskFieldMenuOpen = TaskFieldMenuFromView | TaskFieldMenuFromTask;

/**
 * A target over a live editor document.
 *
 * Two things the old inline version got right and this keeps: the span is
 * tracked from BEFORE the surface opens (`myne#326`, because the autosave
 * rewrites the frontmatter stamp and moves every offset on the line), and every
 * read resolves against the document as it stands NOW rather than against the
 * offsets captured at open time.
 */
function viewTarget(
  view: EditorView,
  lineFrom: number,
): { target: TaskFieldTarget; onClose: () => void; onSkip?: () => void } {
  const line = view.state.doc.lineAt(lineFrom);
  // Minted with kind `repeat` because it spans the WHOLE line; the field
  // actually being written overrides it at the commit.
  const tracked: TaskFieldEditHandle = beginTaskFieldEdit(view, {
    from: line.from,
    to: line.to,
    kind: "repeat",
  });

  /** The live line the surface is about, or null when it was deleted. */
  const currentLine = (): { from: number; to: number; text: string } | null => {
    const span = tracked.current();
    if (span === null) return null;
    const pos = Math.min(span.from, view.state.doc.length);
    return view.state.doc.lineAt(pos);
  };

  const spansNow = (): ReturnType<typeof chipRangesIn> => {
    const at = currentLine();
    return at === null ? [] : chipRangesIn(view.state, at.from, at.to);
  };

  return {
    onClose: () => tracked.end(),
    // The skip action is an editor-side mutation, so it lives on the view's own
    // target and the list path simply does not offer the row: advancing an
    // occurrence needs the note's live document, which a list row does not have
    // (and a list-side skip would be a third mutation, not this task).
    onSkip: () => {
      const span = tracked.current();
      tracked.end();
      if (span !== null) skipOccurrence(view, span.from);
    },
    target: {
      present: () => {
        const out = new Set<TaskFieldKind>();
        for (const span of spansNow()) out.add(span.kind);
        return out;
      },
      valueOf: (kind) => spansNow().find((span) => span.kind === kind)?.value ?? "",
      lineText: () => currentLine()?.text ?? null,
      commit: (kind, value) => {
        const span = tracked.current();
        // A null span means the line was deleted while the surface was open.
        if (span === null) return;
        applyTaskFieldEdit(view, { ...span, kind }, value);
      },
    },
  };
}

/**
 * The menu as an anchored popover: two panes beside the caret, or beside the row
 * control on the list path.
 *
 * The list is built ONCE, from the line at open time, and does not re-read after
 * a commit. Only the docked wizard does, because only it stays open on the list
 * (B19).
 */
function openAnchoredMenu(opts: {
  anchor: HTMLElement | Rect;
  target: TaskFieldTarget;
  onClose?: () => void;
  /** The skip action, when the target can perform one. Absent → no skip row. */
  onSkip?: () => void;
}): void {
  const { anchor, target } = opts;
  const present = target.present();

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
      opts.onClose?.();
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
    // The line as it stands NOW (myne#326). Null means it was deleted.
    if (target.lineText() === null) {
      opts.onClose?.();
      modal.close();
      return;
    }
    activeEditor?.close();
    activeEditor = openTaskFieldEditor({
      host: { body: pane },
      anchor,
      kind,
      value: target.valueOf(kind),
      onCommit: (next) => {
        activeEditor = null;
        // An anchorless repeat is inert (myne#276). Rather than refuse the rule
        // the user typed - which would discard it - offer the anchor it needs, in
        // the same pane, immediately.
        const afterWrite = (): void => {
          const written = target.lineText();
          if (kind === "repeat" && next !== "" && written !== null && !canRecur(written)) {
            openKind("due");
            return;
          }
          renderHint();
        };
        settleCommit(target.commit(kind, next), afterWrite, renderHint);
      },
      onCancel: () => {
        activeEditor = null;
        renderHint();
      },
    });
  };

  let firstRow: HTMLButtonElement | null = null;
  for (const kind of MENU_KINDS) {
    const row = buildFieldRow(kind, present, repeatNeedsAnchor, () => openKind(kind));
    if (firstRow === null) firstRow = row;
    list.appendChild(row);
  }

  if (opts.onSkip !== undefined) {
    const skipRow = appendSkipAction(list, target.lineText() ?? "", () => {
      // The skip action performs its own document work, including ending its
      // tracking, so the surface is torn down WITHOUT calling `onClose` (which
      // would end the same tracking a second time).
      opts.onSkip?.();
      modal.close();
    });
    if (firstRow === null) firstRow = skipRow;
  }

  renderHint();
  modal.backdrop.appendChild(surface);

  // Position after mounting so the surface has measurable dimensions. A bare rect
  // (the slash command's caret coordinate) is used as-is, exactly as the field
  // editor's own modal path treats it.
  const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
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

/**
 * The same menu as a bottom sheet (myne-md/myne#884), which is what a client that
 * declares the docked presentation gets.
 *
 * **Two steps in one sheet.** The field list, then the chosen field's editor with
 * a Back control that returns to the list. The alternative, one scroll holding all
 * four editors, was rejected because the calendar and the recurrence builder are
 * tall and would push each other off the screen.
 *
 * **The list is re-read after every commit.** Its rows say "Edit due date" for a
 * field the line carries and "Due date" for one it does not, so a stale list would
 * offer to ADD the field the user just set, which is the surface stating the
 * opposite of the truth about the line.
 *
 * The write path is the target's: one tracked document span on the editor paths,
 * the view-free sequence on the list path.
 */
function openDockedWizard(opts: {
  target: TaskFieldTarget;
  initialKind?: TaskFieldKind;
  onClose?: () => void;
  /** The skip action, when the target can perform one. Absent → no skip row. */
  onSkip?: () => void;
}): void {
  const { target } = opts;
  let activeEditor: TaskFieldEditorHandle | null = null;

  const modal = openModal({
    backdropStyle: {
      position: "fixed",
      inset: "0",
      // The themed scrim. The canon allows exactly one translucent surface and
      // names the modal case as what it is for; a full-width sheet pinned to the
      // bottom edge is that case, and the transparent backdrop the anchored
      // popover uses would leave a floating box over an undimmed page.
      //
      // No literal fallback here, deliberately: `--scrim` is declared by the shared
      // token sheet every client imports, and a colour literal in this file is
      // counted by the token-adoption ratchet.
      background: "var(--scrim)",
      zIndex: "2147483000",
    },
    onDismiss: () => {
      // Escape peels one layer at a time: an open listbox, then the field step,
      // then the sheet itself.
      if (activeEditor !== null) {
        if (activeEditor.escape?.()) return;
        activeEditor.close();
        activeEditor = null;
        renderList();
        return;
      }
      opts.onClose?.();
      sheet.dispose();
      modal.close();
    },
  });

  const sheet = createDockedSheet({
    title: i18n.t("editor.taskField.menuTitle"),
    testId: "editor.task-field-sheet",
    backLabel: i18n.t("common.back"),
    closeLabel: i18n.t("common.close"),
    onClose: () => {
      activeEditor?.close();
      activeEditor = null;
      opts.onClose?.();
      sheet.dispose();
      modal.close();
    },
  });
  modal.backdrop.appendChild(sheet.root);

  const renderList = (): void => {
    activeEditor?.close();
    activeEditor = null;
    sheet.setTitle(i18n.t("editor.taskField.menuTitle"));
    sheet.setBack(null);

    const present = target.present();
    const list = document.createElement("div");
    list.className = "cm-docked-sheet-list";
    list.setAttribute("role", "menu");
    const repeatNeedsAnchor = !present.has("due") && !present.has("remind");
    for (const kind of MENU_KINDS) {
      list.appendChild(buildFieldRow(kind, present, repeatNeedsAnchor, () => openKind(kind)));
    }
    if (opts.onSkip !== undefined) {
      appendSkipAction(list, target.lineText() ?? "", () => {
        // See the anchored twin: the skip action ends its own tracking, so this
        // path tears the sheet down WITHOUT calling `onClose`.
        opts.onSkip?.();
        sheet.dispose();
        modal.close();
      });
    }
    sheet.body.replaceChildren(list);
  };

  const openKind = (kind: TaskFieldKind): void => {
    const existing = target.valueOf(kind);
    activeEditor?.close();
    sheet.setTitle(i18n.t(`editor.taskField.title.${kind}`));
    sheet.setBack(renderList);
    activeEditor = openTaskFieldEditor({
      // The docked shape: the controls scroll, the actions row does not.
      host: { body: sheet.body, actions: sheet.actions },
      anchor: sheet.root,
      kind,
      value: existing,
      onCommit: (next) => {
        activeEditor = null;
        // An anchorless repeat is inert, so offer its anchor in the same sheet
        // rather than refusing the write the user already wrote (myne#276).
        const afterWrite = (): void => {
          const written = target.lineText();
          if (kind === "repeat" && next !== "" && written !== null && !canRecur(written)) {
            openKind("due");
            return;
          }
          renderList();
        };
        settleCommit(target.commit(kind, next), afterWrite, renderList);
      },
      onCancel: () => {
        activeEditor = null;
        renderList();
      },
    });
  };

  renderList();
  // A chip tap and a slash command arrive with a field already chosen, so enter
  // its step straight away. The list stays one Back away, which is what makes the
  // three entry points one surface rather than two.
  if (opts.initialKind !== undefined) openKind(opts.initialKind);
  // The trap is on the sheet, so a backdrop click still dismisses: the same
  // contract the anchored menu has with its own surface.
  modal.installTrap(sheet.root, null);
}

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
  // Docked, a slash command opens the SAME sheet the `+` affordance does, entered
  // on the field it named, with the list one Back away. That is the whole point of
  // routing both here rather than letting each build its own surface
  // (myne-md/myne#884).
  if (floatingSurfacePresentation() === "docked") {
    openTaskFieldMenu({ view, anchor, lineFrom, initialKind: kind });
    return;
  }

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
 * Open the "add field" menu for a task line (myne-md/myne#884).
 *
 * **One component, two callers.** With a `view` it is the `+` affordance, the
 * chip and the slash commands, and the line is a tracked document span. With a
 * `target` it is the task list's own control, where there is no document at all
 * and a field is written with the view-free sequence instead. Everything below
 * the line - the rows, the wizard, the commit chaining, the dismissal - is the
 * same code, which is what stops the two entry points from behaving differently.
 *
 * A kind the line already carries is relabelled "Edit ..." and routes through the
 * same opener (which prefills it) - strictly more useful than hiding it, and it
 * reuses the seam.
 *
 * A **skip** row joins them when the caret's line carries a recurrence rule that
 * can actually be advanced (myne#198). It sits below a separator because it is
 * categorically different from its neighbours: the other rows open an editor to
 * change a value, this one performs an action and closes. The test for showing it
 * is deliberately "can this occurrence be skipped", not "does this line carry a
 * repeat field" - offering an action that would silently do nothing on an
 * unreadable or anchorless rule is the same failure the chip layer forbids itself
 * in `decorations/task-chip.ts`. It is a VIEW-side action, so a target without a
 * document simply does not offer the row.
 */
export function openTaskFieldMenu(opts: TaskFieldMenuOpen): void {
  const source = "view" in opts ? viewTarget(opts.view, opts.lineFrom) : opts;

  // The docked presentation is a different ANATOMY, not a different stylesheet:
  // one step of a wizard in a bottom sheet, rather than two panes beside the
  // caret. It therefore has its own layout, and the anchored one stays exactly as
  // it was for every client that did not ask for sheets (myne-md/myne#884).
  if (floatingSurfacePresentation() === "docked") {
    openDockedWizard({
      target: source.target,
      initialKind: opts.initialKind,
      onClose: source.onClose,
      onSkip: source.onSkip,
    });
    return;
  }

  openAnchoredMenu({
    anchor: opts.anchor,
    target: source.target,
    onClose: source.onClose,
    onSkip: source.onSkip,
  });
}

/**
 * One field row. Shared by both presentations so the two lists cannot drift on
 * which fields they offer, what those are called, or how a field the line already
 * carries is labelled ("Edit due date" rather than "Due date"). The test id is
 * shared too, deliberately: a test can then target one row regardless of the
 * presentation it is looking at, and the CONTAINER is what says which one it is.
 */
function buildFieldRow(
  kind: TaskFieldKind,
  present: ReadonlySet<TaskFieldKind>,
  repeatNeedsAnchor: boolean,
  onPick: () => void,
): HTMLButtonElement {
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
  row.addEventListener("click", onPick);
  return row;
}

/**
 * The skip ACTION, below a separator: categorically different from the rows above
 * it, which open a value editor, because this one performs something and closes.
 *
 * Offered only when the caret line's rule can actually be advanced (`myne#198`),
 * never merely because the line carries a repeat field: offering an action that
 * would silently do nothing on an unreadable or anchorless rule is the same
 * failure the chip layer forbids itself. Returns the row, or null when there is
 * nothing to advance.
 */
function appendSkipAction(
  list: HTMLElement,
  lineText: string,
  onSkip: () => void,
): HTMLButtonElement | null {
  if (!canSkipOccurrence(lineText)) return null;
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
  row.addEventListener("click", onSkip);
  list.appendChild(row);
  return row;
}
