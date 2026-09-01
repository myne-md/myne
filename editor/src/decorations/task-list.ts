// Task list decoration (`- [ ]` / `- [x]`) for the Phase 1 editor.
//
// PRD `editor-mvp-baseline` stories 24–25. The @lezer/markdown GFM extension
// names the marker `TaskMarker` inside a `ListItem`. The marker text is
// literally `[ ]` (unchecked) or `[x]` (checked).
//
// Click handler dispatches a CM6 transaction toggling the source `[ ]` ↔ `[x]`
// so undo/redo treats it as a single step.
//
// The checkbox is cursor-aware (myne-md/myne#563): the `- [ ]` run lifts back to
// source when a selection sits inside it, like every other live-preview
// construct, and re-renders when the caret leaves. It used to mount through
// `makeDocOnlyDecorationPlugin`, whose gate does not watch the selection at all,
// so the marker was the one piece of markdown in the editor with no way to see
// what it stood for.
//
// A **recurring** task takes a different path first (myne#198): ticking one
// materializes its next occurrence and un-ticking one removes the occurrence it
// materialized, each as a single transaction carrying both changes. The
// recurrence functions decline (`false`) on any line that is not a recurring
// task, which is what leaves the ordinary flip below as the fallback rather than
// as a branch this file has to decide between.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";
import { revealsRange } from "./cursor-aware";
import { listLabelStart } from "./list";
import { completeRecurringTask, uncompleteRecurringTask } from "./task-recurrence";

class TaskCheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly markerFrom: number,
  ) {
    super();
  }
  eq(other: TaskCheckboxWidget): boolean {
    // Must compare markerFrom too: the click handler closes over it to target
    // the toggle. If only `checked` matched, CM6 would reuse an old widget's
    // DOM (and stale closure) after edits shift the marker, so clicking would
    // rewrite the wrong document range.
    return other.checked === this.checked && other.markerFrom === this.markerFrom;
  }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = this.checked
      ? "cm-task-checkbox cm-task-checkbox-checked"
      : "cm-task-checkbox";
    span.setAttribute("role", "checkbox");
    span.setAttribute("aria-checked", String(this.checked));
    // Observability only (SYNC-8). The rendered checkbox is the only readable
    // proof of a task line's state in live preview: the `- [x]` marker itself is
    // decoration-hidden, so a scenario asserting on document text cannot see a
    // tick land — including the cross-note write a query block performs into a
    // note the user is not looking at.
    span.setAttribute("data-testid", "editor.task-checkbox");
    // MYND-614 task 10 — inherited debt, fixed here rather than deferred. The
    // checkbox carried a role and a checked state but NO accessible name and NO
    // focus stop, which made it mouse-only. Shipping fully accessible chips
    // beside a mouse-only checkbox would have been an inconsistency the user
    // feels immediately: same line, two affordances, one reachable.
    // Not a focus stop and not a pointer on a surface that will refuse the
    // toggle: an affordance that looks live and does nothing is worse than none.
    const editable = !view.state.readOnly;
    if (editable) span.setAttribute("tabindex", "0");
    span.setAttribute(
      "aria-label",
      this.checked ? "Task, completed" : "Task, not completed",
    );
    span.setAttribute("aria-disabled", String(!editable));
    span.style.cursor = editable ? "pointer" : "default";

    const toggle = (): void => {
      // Read-only surfaces refuse (myne-md/myne#564). `EditorState.readOnly` is
      // consulted by COMMANDS; this widget dispatches straight into the document
      // from a DOM handler, so it inherits nothing from that flag and has to
      // check it. Two things went wrong without this, and the second is worse
      // than the first: a reading-mode tab wrote the note on a surface documented
      // as strict read-only, and the reading COMPANION mirror (`PaneView`, whose
      // `onChange` is a no-op) flipped the box on screen and threw the write
      // away, so the tick looked like it landed and vanished at the next value
      // adoption.
      if (view.state.readOnly) return;
      // Resolve the marker position live from the DOM rather than trusting the
      // closure: if CM6 reused this widget's DOM, the captured `markerFrom`
      // could be stale and the toggle would rewrite the wrong range. Read the
      // current 3-char marker (`[ ]` / `[x]`) at that position and flip it.
      const from = view.posAtDOM(span);
      const current = view.state.doc.sliceString(from, from + 3);
      if (current !== "[ ]" && current !== "[x]" && current !== "[X]") return;

      // The recurring paths go first, and each carries the marker flip itself —
      // so a materialization and its flip ride ONE transaction and one undo
      // restores both. Both decline on a line that is not a recurring task,
      // leaving the plain flip below.
      if (current === "[ ]") {
        if (completeRecurringTask(view, from)) return;
      } else if (uncompleteRecurringTask(view, from)) {
        return;
      }

      const next = current === "[ ]" ? "[x]" : "[ ]";
      view.dispatch({
        changes: { from, to: from + 3, insert: next },
        userEvent: "task.toggle",
      });
    };

    span.addEventListener("keydown", (e) => {
      // Space is the checkbox convention; Enter is accepted too so the two
      // affordances on a task line behave the same way under the keyboard.
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });

    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      toggle();
    });
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function buildTaskListDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "TaskMarker") return undefined;
        const marker = view.state.doc.sliceString(node.from, node.to);
        const checked = marker === "[x]" || marker === "[X]";
        // Hide the Markdown list bullet ("- " / "* " / "+ ") preceding the
        // checkbox so the rendered line reads as just [checkbox] label, not
        // "- [checkbox] label". Indentation (leading whitespace) is preserved.
        const line = view.state.doc.lineAt(node.from);
        // Where the label begins, asked once for the two decorations that need
        // it: the separator this file swallows, and the strike over a completed
        // item's text. `list.ts` owns the answer because its hanging indent is
        // measured against the same column (myne-md/myne#594).
        const labelStart = listLabelStart(line, node.to);
        const before = view.state.doc.sliceString(line.from, node.from);
        const bullet = before.match(/^(\s*)[-*+]\s+$/);
        const bulletStart =
          bullet === null ? node.from : line.from + (bullet[1] ?? "").length;
        // Cursor-aware reveal (myne-md/myne#563, myne-md/myne#560). Three
        // choices in one line:
        //
        //  - the hidden run is `- [ ]` TOGETHER, not the marker alone. Lifting
        //    `[ ]` while the bullet stayed hidden renders a line that is neither
        //    the rendered form nor the source.
        //  - per-RANGE, not per-line (`isCursorLine` would do the latter),
        //    because the label is ordinary prose: typing in it must not make the
        //    checkbox disappear out from under the caret.
        //  - a caret inside the run, OR a selection that overlaps it. The second
        //    clause is what keeps a translucent selection band off the OPAQUE
        //    checkbox fill: if the markup is in the selection, show the markup.
        //    See `revealsRange`.
        if (!revealsRange(view, bulletStart, node.to)) {
          if (node.from > bulletStart) {
            decorations.push(Decoration.replace({}).range(bulletStart, node.from));
          }
          decorations.push(
            Decoration.replace({
              widget: new TaskCheckboxWidget(checked, node.from),
            }).range(node.from, node.to),
          );
          // Swallow the separator between `[ ]` and the label too, exactly as
          // the bullet disc swallows its own (`list.ts`): the gap to the label
          // is then the checkbox's `margin-right` and nothing else, a width the
          // theme states rather than one the font decides. `list.ts` measures
          // the line's hanging indent against that same width, so every source
          // space left painted here is a space its wrapped rows fall short by
          // (myne-md/myne#594).
          //
          // Never on an item with NO label: that separator is then the only
          // text on the line, and a line made of nothing but widgets has
          // nowhere for a typed character to land (myne-md/myne#598).
          if (labelStart > node.to && labelStart < line.to) {
            decorations.push(Decoration.replace({}).range(node.to, labelStart));
          }
        }
        // Strike + mute the label text of a completed item so done items
        // visibly recede (MYND-142). Starts at the first non-space AFTER the
        // marker — so the strike line doesn't run through the gap into the
        // checkbox — and spans to end-of-line; skipped for empty todos.
        if (checked) {
          if (line.to > labelStart) {
            decorations.push(
              Decoration.mark({ class: "cm-task-done-label" }).range(
                labelStart,
                line.to,
              ),
            );
          }
        }
        return undefined;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => a.from - b.from);
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function taskListDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildTaskListDecorations);
}
