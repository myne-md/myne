// Chip activation → field editor → write-back, wired at the window level
// (MYND-614 tasks 6 + 7).
//
// **The wire that was missing.** `task-chip.ts` dispatches `myne-open-task-chip`
// and `task-field-editor.ts` knows how to open — and for a while **nothing
// connected them on any client but one**: the desktop screen installed a
// listener, the mobile editor did not, so on mobile the chips rendered and did
// nothing. Both halves had thorough unit tests; neither could see the missing
// wire, because each tested its own half (`taskChipWiring.test.ts` documents the
// class).
//
// So the listener lives here, imported by BOTH clients, rather than copied into
// each screen. One implementation cannot drift out of parity with itself, and it
// is unit-testable by import instead of by a hand-kept "faithful copy" of a shape
// buried in a multi-thousand-line React screen.
//
// The view is recovered from the DOM (`EditorView.findFromDOM`) rather than
// threaded in, so a chip in ANY pane resolves against its own editor — the same
// reason the `#tag` chip listener does it this way. No Tauri, no platform API:
// this stays in the shared editor package, which the platform-seam guard keeps
// free of `@tauri-apps/*`.

import { EditorView } from "@codemirror/view";
import { openTaskFieldEditor } from "../task-field-editor";
import { openTaskFieldMenu } from "../task-field-menu";
import {
  applyTaskFieldEdit,
  beginTaskFieldEdit,
  TASK_CHIP_EVENT,
  type TaskChipEventDetail,
} from "./task-chip";
import { TASK_ADD_EVENT, type TaskAddEventDetail } from "./task-add-affordance";

/**
 * Install the chip → field-editor listener on `window`. Returns an unsubscribe
 * function, so a React effect can `return installTaskChipEditor()`.
 *
 * Because chips never open on caret entry (task 5), this listener is the ONLY
 * way to edit these values in live mode — it is load-bearing wiring, not
 * convenience.
 */
export function installTaskChipEditor(): () => void {
  const onOpenChip = (e: Event): void => {
    const detail = (e as CustomEvent<TaskChipEventDetail>).detail;
    const target = e.target as HTMLElement | null;
    const anchor = target?.closest?.("[data-task-chip]") as HTMLElement | null;
    if (detail === undefined || anchor === null || anchor === undefined) return;

    const view = EditorView.findFromDOM(anchor);
    if (view === null) return;

    // Track the span across document changes for as long as the popover is open.
    // The document stays live underneath it — a background autosave rewrites the
    // frontmatter stamp about a second after any edit — and writing at the
    // offsets captured on click would land the new value in whatever text has
    // since moved into them.
    const edit = beginTaskFieldEdit(view, detail);
    openTaskFieldEditor({
      anchor,
      kind: detail.kind,
      value: detail.value,
      onCommit: (next) => {
        const span = edit.current();
        edit.end();
        // Null means the field was deleted while the popover was open; declining
        // is the only correct answer.
        if (span !== null) applyTaskFieldEdit(view, span, next);
      },
      onCancel: () => edit.end(),
    });
  };

  // The `+` affordance (task-add-affordance.ts) dispatches this; open the
  // three-way add-field menu anchored to the button. Recovered from the DOM the
  // same way as the chip, so a `+` in any pane resolves against its own editor.
  const onOpenAdd = (e: Event): void => {
    const detail = (e as CustomEvent<TaskAddEventDetail>).detail;
    const target = e.target as HTMLElement | null;
    const anchor = target?.closest?.("[data-task-add]") as HTMLElement | null;
    if (detail === undefined || anchor === null || anchor === undefined) return;

    const view = EditorView.findFromDOM(anchor);
    if (view === null) return;

    openTaskFieldMenu({ view, anchor, lineFrom: detail.lineFrom });
  };

  window.addEventListener(TASK_CHIP_EVENT, onOpenChip);
  window.addEventListener(TASK_ADD_EVENT, onOpenAdd);
  return () => {
    window.removeEventListener(TASK_CHIP_EVENT, onOpenChip);
    window.removeEventListener(TASK_ADD_EVENT, onOpenAdd);
  };
}
