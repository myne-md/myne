// The editor that opens from a task chip (MYND-614 task 6).
//
// Assembled entirely from what already exists — **zero new dependencies**, since
// a date-picker package would be a security decision needing a dependency-ledger
// row and its own decision entry:
//
//   - `openModal` (host/lib/imperative-modal) for the focus trap, Esc dismissal
//     and backdrop click;
//   - `computePosition` (positioning.ts) for the viewport clamp and above/below
//     flip, so the surface never opens off-screen;
//   - the platform `<input type="date">`, which MYND-614 task 1 measured as
//     fully supported on both reachable WebViews (macOS WKWebView and Linux
//     WebKitGTK: type retained, `showPicker()` callable, `valueAsDate`
//     round-trips, invalid values rejected). That measurement is what makes this
//     a thin wrapper rather than a hand-rolled calendar grid.
//
// **This is the only way to edit these values in live mode.** Chips never open
// on caret entry (task 5), so it must be complete and fully keyboard-reachable
// from day one — not a follow-up. Every control here is focusable, the trap
// cycles them, Enter commits, and Escape dismisses without changing anything.

import { computePosition } from "./positioning";
import { openModal } from "./host/lib/imperative-modal";

export type TaskFieldKind = "due" | "repeat" | "priority";

export const PRIORITY_VALUES = ["highest", "high", "medium", "low", "lowest"] as const;

export type TaskFieldEditorOptions = {
  /** The chip element the editor is anchored to. */
  anchor: HTMLElement;
  kind: TaskFieldKind;
  /** Current value, as written in the source. */
  value: string;
  /** Called with the new value when the user commits. Never called on dismiss. */
  onCommit: (next: string) => void;
  /** Called when dismissed without committing. */
  onCancel?: () => void;
  /** Labels, injected so this module stays i18n-agnostic. */
  labels?: { commit?: string; cancel?: string; field?: string };
};

export type TaskFieldEditorHandle = { close: () => void };

/** The one input the surface edits, built per field kind. */
function buildInput(kind: TaskFieldKind, value: string): HTMLElement & { value: string } {
  if (kind === "priority") {
    const select = document.createElement("select");
    for (const level of PRIORITY_VALUES) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      select.appendChild(option);
    }
    select.value = PRIORITY_VALUES.includes(value as never) ? value : "medium";
    select.setAttribute("data-testid", "editor.task-field-input");
    return select;
  }

  const input = document.createElement("input");
  if (kind === "due") {
    // Task 1's measurement: the native control is real on both reachable
    // engines, so this is a thin wrapper. A date-only value goes straight in; a
    // value carrying a time keeps its date part (the time editor is a later
    // slice, and dropping it silently would be worse than ignoring it here).
    input.type = "date";
    input.value = value.slice(0, 10);
  } else {
    // Recurrence: free text. The rule vocabulary belongs to MYND-615, so this
    // layer must not pretend to validate it.
    input.type = "text";
    input.value = value;
  }
  input.setAttribute("data-testid", "editor.task-field-input");
  return input;
}

/**
 * Open the editor for one task field, anchored to its chip.
 *
 * Returns a handle whose `close` is idempotent. Escape and a backdrop click
 * dismiss **without** committing; Enter and the commit button commit.
 */
export function openTaskFieldEditor(
  options: TaskFieldEditorOptions,
): TaskFieldEditorHandle {
  const { anchor, kind, value, onCommit, onCancel, labels } = options;

  let committed = false;

  const modal = openModal({
    backdropStyle: {
      // Transparent: this is an anchored popover, not a blocking dialog. The
      // backdrop exists for click-outside dismissal and the focus trap.
      background: "transparent",
    },
    onDismiss: () => {
      modal.close();
      if (!committed) onCancel?.();
    },
    onEnter: (e) => {
      e.preventDefault();
      commit();
    },
  });

  const surface = document.createElement("div");
  surface.className = "cm-task-field-editor";
  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-label", labels?.field ?? kind);
  surface.setAttribute("data-testid", "editor.task-field-editor");
  surface.style.position = "fixed";

  const input = buildInput(kind, value);
  surface.appendChild(input);

  const commitButton = document.createElement("button");
  commitButton.type = "button";
  commitButton.textContent = labels?.commit ?? "Save";
  commitButton.setAttribute("data-testid", "editor.task-field-commit");
  surface.appendChild(commitButton);

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = labels?.cancel ?? "Cancel";
  cancelButton.setAttribute("data-testid", "editor.task-field-cancel");
  surface.appendChild(cancelButton);

  function commit(): void {
    committed = true;
    const next = input.value;
    modal.close();
    onCommit(next);
  }

  commitButton.addEventListener("click", commit);
  cancelButton.addEventListener("click", () => {
    modal.close();
    onCancel?.();
  });

  modal.backdrop.appendChild(surface);

  // Position after mounting so the surface has measurable dimensions. The
  // positioner owns the viewport clamp and the above/below flip.
  const rect = anchor.getBoundingClientRect();
  const placed = computePosition({
    anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    surfaceWidth: surface.offsetWidth || 240,
    surfaceHeight: surface.offsetHeight || 96,
    preferredPlacement: "below",
  });
  surface.style.left = `${placed.left}px`;
  surface.style.top = `${placed.top}px`;

  // Trap on the surface, not the backdrop, so a backdrop click still dismisses.
  // Initial focus is the input: the whole surface is reachable by keyboard alone
  // from here — Tab cycles input → Save → Cancel and wraps.
  modal.installTrap(surface, input);

  return {
    close: () => {
      modal.close();
    },
  };
}
