// The `+` "add task field" affordance at the end of a task line.
//
// A cursor-aware POINT widget (not a `replace`, not a block): it consumes no
// text, so it never participates in `atomicRanges` and the caret sits naturally
// before or after it. It appears at `line.to` only while the caret is on that
// task line — the same `isCursorLine` gate every edit affordance uses, which
// also hides it in reading view and when the editor is unfocused. Source mode
// empties the whole decoration stack, so there is no `+` there either.
//
// Activation mirrors the chip: `preventDefault` + a bubbling CustomEvent the
// window-level listener (`task-chip-listener.ts`) answers by opening the
// mini-menu. Keeping the wire at the window means one install site shared by
// desktop and mobile, unit-testable by import — the reason the chip listener
// lives there too.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";
import { isCursorLine } from "./cursor-aware";
import i18n from "@myne/editor/i18n";

/** Fired when the `+` affordance is activated; the host opens the add-field menu. */
export const TASK_ADD_EVENT = "myne-open-task-add";

export type TaskAddEventDetail = {
  /** The `from` offset of the task line the `+` belongs to. */
  lineFrom: number;
};

class TaskAddWidget extends WidgetType {
  eq(): boolean {
    // Every `+` is interchangeable: it carries no per-line state — the line is
    // resolved live from the DOM on activation (`view.posAtDOM`), so CM6 may
    // reuse any instance's DOM freely without a stale-closure hazard.
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-task-add";
    button.setAttribute("data-task-add", "");
    // Observability + the anchor the listener recovers the menu against.
    button.setAttribute("data-testid", "editor.task-add-field");
    button.setAttribute("tabindex", "0");
    button.setAttribute("aria-label", i18n.t("editor.taskField.addAffordance"));
    button.textContent = "+";

    const fire = (): void => {
      // Resolve the line live from the DOM rather than a closure — an edit above
      // shifts every offset below it, and CM6 may reuse this widget's DOM.
      const pos = view.posAtDOM(button);
      const line = view.state.doc.lineAt(pos);
      button.dispatchEvent(
        new CustomEvent<TaskAddEventDetail>(TASK_ADD_EVENT, {
          bubbles: true,
          detail: { lineFrom: line.from },
        }),
      );
    };

    button.addEventListener("mousedown", (e) => {
      // preventDefault so the click doesn't move the caret into the content and
      // trip a reveal — the checkbox / chip precedent.
      e.preventDefault();
      fire();
    });
    button.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      fire();
    });
    return button;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildTaskAddDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "TaskMarker") return undefined;
        const line = view.state.doc.lineAt(node.from);
        // Only while the caret is on this task line.
        if (!isCursorLine(view, line.from, line.to)) return undefined;
        decorations.push(
          Decoration.widget({ widget: new TaskAddWidget(), side: 1 }).range(line.to),
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

export function taskAddAffordanceDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildTaskAddDecorations);
}
