// The `+` "add task field" affordance at the end of a task line.
//
// A caret-aware POINT widget (not a `replace`, not a block): it consumes no
// text, so it never participates in `atomicRanges` and the caret sits naturally
// before or after it. It appears at `line.to` only while a CARET is on that task
// line: `isCaretLine`, which also hides it in reading view, when the editor is
// unfocused, and while any text is selected. Source mode empties the whole
// decoration stack, so there is no `+` there either.
//
// The "while any text is selected" half is not a style preference. This widget
// enters the line's DOM in the same update that moves the selection, so
// `drawSelection` can measure the row mid-change, conclude the selection's two
// ends are on different visual rows, and paint the two-rectangle form: one band
// running to the right edge, another from the left edge, overlapping over the
// text and doubling a translucent wash where they meet. Nothing recomputes it
// afterwards. `isCaretLine` carries the measurement (myne-md/myne#560).
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
import { isCaretLine } from "./cursor-aware";
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
    // The zero-size slot (myne#660). #560 cancelled this widget's VERTICAL
    // contribution and said in its own comment that the horizontal half was
    // still open: "the box below still contributes inline WIDTH when the caret
    // arrives, so on a row near the wrap width it can still force a wrap …
    // taking the widget out of flow would close that". This is that.
    //
    // A `width: 0; height: 0` inline-block with `overflow: visible` gives the
    // line the same metrics whether the `+` is in the DOM or not, so the
    // appearance and disappearance that ride along with every selection change
    // can no longer move the wrap point mid-measure. The button keeps its own
    // metrics and simply overflows the slot.
    const slot = document.createElement("span");
    slot.className = "cm-task-add-slot";
    // `data-task-add` lives on the SLOT, not the button, and it has to.
    // `task-chip-listener.ts` resolves the editor with
    // `EditorView.findFromDOM(target.closest("[data-task-add]"))`, and
    // `findFromDOM` answers only for a node CM6 has attached a ContentView to ,
    // which is the widget's root. With the marker on the button it resolved
    // null, `onOpenAdd` returned early, and the whole `+` menu stopped opening
    // while every other symptom (the widget renders, the event fires, `closest`
    // matches) looked correct.
    slot.setAttribute("data-task-add", "");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-task-add";
    // Observability + the anchor the listener recovers the menu against.
    button.setAttribute("data-testid", "editor.task-add-field");
    button.setAttribute("tabindex", "0");
    button.setAttribute("aria-label", i18n.t("editor.taskField.addAffordance"));
    button.textContent = "+";

    const fire = (): void => {
      // Resolve the line live from the DOM rather than a closure — an edit above
      // shifts every offset below it, and CM6 may reuse this widget's DOM.
      //
      // Resolve against the SLOT, not the button. The slot is the widget's root
      // DOM node, which is what CM6 has registered a position for; asking about
      // the button, now a child of the slot rather than the root, resolves
      // against a node the view does not know, and the whole `+` menu silently
      // stops opening.
      const pos = view.posAtDOM(slot);
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
    slot.appendChild(button);
    return slot;
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
        // Only while a CARET is on this task line, never merely a selection.
        // See `isCaretLine` for why the distinction is load-bearing rather than
        // cosmetic (myne-md/myne#560).
        if (!isCaretLine(view, line.from, line.to)) return undefined;
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
