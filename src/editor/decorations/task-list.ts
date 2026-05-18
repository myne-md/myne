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
    return other.checked === this.checked;
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
      const from = this.markerFrom;
      // The marker spans `[ ]` (3 chars) or `[x]` (3 chars).
      const next = this.checked ? "[ ]" : "[x]";
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
        decorations.push(
          Decoration.replace({
            widget: new TaskCheckboxWidget(checked, node.from),
          }).range(node.from, node.to),
        );
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
