// Task list decoration (`- [ ]` / `- [x]`) for the Phase 1 editor.
//
// PRD `editor-mvp-baseline` stories 24–25. The @lezer/markdown GFM extension
// names the marker `TaskMarker` inside a `ListItem`. The marker text is
// literally `[ ]` (unchecked) or `[x]` (checked).
//
// Click handler dispatches a CM6 transaction toggling the source `[ ]` ↔ `[x]`
// so undo/redo treats it as a single step.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { makeDocOnlyDecorationPlugin } from "./plugin-factory";

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
    span.style.cursor = "pointer";
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      // Resolve the marker position live from the DOM rather than trusting the
      // closure: if CM6 reused this widget's DOM, the captured `markerFrom`
      // could be stale and the toggle would rewrite the wrong range. Read the
      // current 3-char marker (`[ ]` / `[x]`) at that position and flip it.
      const from = view.posAtDOM(span);
      const current = view.state.doc.sliceString(from, from + 3);
      if (current !== "[ ]" && current !== "[x]" && current !== "[X]") return;
      const next = current === "[ ]" ? "[x]" : "[ ]";
      view.dispatch({
        changes: { from, to: from + 3, insert: next },
        userEvent: "task.toggle",
      });
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
        const before = view.state.doc.sliceString(line.from, node.from);
        const bullet = before.match(/^(\s*)[-*+]\s+$/);
        if (bullet !== null) {
          const bulletStart = line.from + (bullet[1] ?? "").length;
          if (node.from > bulletStart) {
            decorations.push(Decoration.replace({}).range(bulletStart, node.from));
          }
        }
        decorations.push(
          Decoration.replace({
            widget: new TaskCheckboxWidget(checked, node.from),
          }).range(node.from, node.to),
        );
        // Strike + mute the label text of a completed item so done items
        // visibly recede (MYND-142). Starts at the first non-space AFTER the
        // marker — so the strike line doesn't run through the gap into the
        // checkbox — and spans to end-of-line; skipped for empty todos.
        if (checked) {
          const line = view.state.doc.lineAt(node.to);
          const gap = view.state.doc.sliceString(node.to, line.to).match(/^\s+/);
          const labelStart = node.to + (gap ? gap[0].length : 0);
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
  return makeDocOnlyDecorationPlugin(buildTaskListDecorations);
}
