// The task-query fenced block, rendered as a live list (MYND-617, tasks 4, 6, 12).
//
// A **port of the diagram block**, near enough to read as one: find a closed
// `FencedCode` in the tree, compare its info string, and block-replace the whole
// block with a widget from a **`StateField`** — because a block-level
// replacement cannot come from a view plugin. No parser extension is needed; the
// info string is already in the tree. `fenced-code.ts` gets the same one-line
// skip it already has for diagrams, so two block-replaces never collide.
//
// SELF-REFERENCE IS IMPOSSIBLE BY CONSTRUCTION. Content inside a fence never
// produces task markers — the tokenizer does not descend into a code node — so a
// block can never match itself, and no cycle guard is needed.
//
// BYTE STABILITY. Rendering reads; it never writes. The block's raw bytes are
// untouched by every path here (§6 C1), which is what lets a file round-trip
// unchanged while showing a live list.
//
// REVEAL: caret entry reveals the **whole block**, not a fragment — the table
// and diagram rule, and for the same reason: a block widget is atomic, so
// revealing part of it is not expressible. Source mode never renders. Reading
// mode always does, **and its checkbox stays live**: reading mode makes the
// HOST note read-only, and this write targets a different note entirely. A dead
// checkbox here would also contradict the panel, which is always interactive.
//
// DROPPED CLAUSES ARE REPORTED INSIDE THE WIDGET, PERMANENTLY — never a toast.
// The block re-renders on every note open, so a toast would nag forever, and a
// show-once toast goes silent afterwards, which is precisely the failure the
// visible-drop rule exists to prevent.

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { LineHeightWidget } from "../widget-line-coords";
import i18n from "@myne/editor/i18n";
import {
  editorFocusChanged,
  editorFocusField,
  editorFocusTracker,
  linesRevealed,
  readingModeFacet,
  selectionTouchesLines,
} from "./cursor-aware";

/** The fence info string that turns a code block into a task list. */
export const TASK_QUERY_INFO = "tasks";

/** One row the host hands the widget to render. Deliberately flat and inert. */
export type TaskQueryRow = {
  readonly key: string;
  readonly text: string;
  readonly completed: boolean;
  readonly noteTitle: string | null;
  readonly due?: string;
  readonly oversized?: boolean;
};

/** What the host computes for one block. The widget renders it and nothing else. */
export type TaskQueryRender = {
  readonly rows: readonly TaskQueryRow[];
  readonly remainder: number;
  /** Clause texts the parser could not read, verbatim. */
  readonly dropped: readonly string[];
  /** Every clause was dropped — refuse rather than widen. */
  readonly refused: boolean;
};

/**
 * The host pushes results in as a **reconfiguration**, not as a new host
 * interface member.
 *
 * That matters beyond tidiness: a host-interface addition has mobile-parity
 * consequences (the mobile client must implement it before the editor package
 * can be shared), and this needs none — it is the same remount-free
 * compartment push the vault-wide note-set already uses.
 */
export const setTaskQueryResults = StateEffect.define<ReadonlyMap<string, TaskQueryRender>>();

const taskQueryResultsField = StateField.define<ReadonlyMap<string, TaskQueryRender>>({
  create: () => new Map(),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTaskQueryResults)) return e.value;
    return value;
  },
});

/** Fired when a row's checkbox is activated; the host performs the write. */
export const TASK_QUERY_TOGGLE_EVENT = "myne-task-query-toggle";
/** Fired when a row's source note is activated. */
export const TASK_QUERY_OPEN_EVENT = "myne-task-query-open";

export type TaskQueryRowEventDetail = { queryKey: string; rowKey: string };

/** One block found in the document. `key` is its query text — stable identity. */
export type TaskQueryBlock = { from: number; to: number; query: string };

/**
 * Every task-query block in the document, in order.
 *
 * Exported so the host can compute results for exactly the blocks that exist,
 * without a second tree walk that could disagree with this one.
 */
export function taskQueryBlocks(state: EditorState): TaskQueryBlock[] {
  const doc = state.doc;
  const blocks: TaskQueryBlock[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return undefined;
      // Closed fence only — an unclosed one is still being typed.
      if (node.node.getChildren("CodeMark").length < 2) return false;
      const infoNode = node.node.getChild("CodeInfo");
      const info = infoNode ? doc.sliceString(infoNode.from, infoNode.to).trim().toLowerCase() : "";
      if (info !== TASK_QUERY_INFO) return false;

      const openLine = doc.lineAt(node.from);
      const closeLine = doc.lineAt(node.to);
      const query = doc
        .sliceString(openLine.to, closeLine.from)
        .replace(/^\n/, "")
        .replace(/\n$/, "");
      blocks.push({ from: openLine.from, to: closeLine.to, query });
      return false;
    },
  });
  return blocks;
}

class TaskQueryWidget extends LineHeightWidget {
  constructor(
    private readonly queryKey: string,
    private readonly render: TaskQueryRender | undefined,
    /** Source position, part of widget identity — the chip-widget lesson. */
    private readonly from: number,
  ) {
    super();
  }

  eq(other: TaskQueryWidget): boolean {
    return (
      other.queryKey === this.queryKey &&
      other.from === this.from &&
      other.render === this.render
    );
  }

  toDOM(): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-task-query";
    root.setAttribute("data-testid", "editor.task-query");
    root.setAttribute("data-query-key", this.queryKey);

    const render = this.render;
    if (render === undefined) {
      // Results have not arrived yet. A LOADING state, not an empty list: an
      // empty list here would be a wrong answer presented as a finished one.
      const loading = document.createElement("div");
      loading.className = "cm-task-query-empty";
      loading.setAttribute("data-testid", "editor.task-query.loading");
      loading.textContent = i18n.t("tasks.query.loading");
      root.appendChild(loading);
      return root;
    }

    if (render.refused) {
      // Its OWN treatment, visually distinct from an empty result — a
      // misunderstood query that looked like a correct empty list would send
      // the user hunting for tasks that are actually there.
      const refusal = document.createElement("div");
      refusal.className = "cm-task-query-refused";
      refusal.setAttribute("data-testid", "editor.task-query.refused");
      refusal.textContent = i18n.t("tasks.query.refused");
      root.appendChild(refusal);
      root.appendChild(this.droppedNotice(render.dropped));
      return root;
    }

    if (render.rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cm-task-query-empty";
      empty.setAttribute("data-testid", "editor.task-query.empty");
      empty.textContent = i18n.t("tasks.query.empty");
      root.appendChild(empty);
    }

    for (const row of render.rows) {
      root.appendChild(this.rowDom(row));
    }

    if (render.remainder > 0) {
      // A bound with a STATED remainder. Every other cap in this epic says what
      // it dropped; a list quietly showing 100 of 400 is a wrong answer wearing
      // a right answer's clothes.
      const more = document.createElement("div");
      more.className = "cm-task-query-more";
      more.setAttribute("data-testid", "editor.task-query.remainder");
      more.textContent = i18n.t("tasks.query.remainder", { count: render.remainder });
      root.appendChild(more);
    }

    if (render.dropped.length > 0) root.appendChild(this.droppedNotice(render.dropped));
    return root;
  }

  /** The persistent dropped-clause notice. Expandable, never a toast. */
  private droppedNotice(dropped: readonly string[]): HTMLElement {
    const details = document.createElement("details");
    details.className = "cm-task-query-dropped";
    details.setAttribute("data-testid", "editor.task-query.dropped");
    details.setAttribute("data-dropped-count", String(dropped.length));

    const summary = document.createElement("summary");
    summary.textContent = i18n.t("tasks.query.dropped", { count: dropped.length });
    details.appendChild(summary);

    const list = document.createElement("ul");
    for (const clause of dropped) {
      const item = document.createElement("li");
      item.setAttribute("data-testid", "editor.task-query.dropped-clause");
      // `textContent`, never `innerHTML`: this string came out of the user's
      // own file and must not be interpreted as markup.
      item.textContent = clause;
      list.appendChild(item);
    }
    details.appendChild(list);
    return details;
  }

  private rowDom(row: TaskQueryRow): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-task-query-row";
    el.setAttribute("data-testid", "editor.task-query.row");
    el.setAttribute("data-row-key", row.key);

    const box = document.createElement("span");
    box.className = row.completed
      ? "cm-task-query-box cm-task-query-box-done"
      : "cm-task-query-box";
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(row.completed));
    box.setAttribute("data-testid", "editor.task-query.checkbox");
    if (row.oversized === true) {
      box.setAttribute("aria-disabled", "true");
      box.setAttribute("tabindex", "-1");
      box.title = i18n.t("tasks.row.tooLongToWrite");
    } else {
      box.setAttribute("tabindex", "0");
      box.setAttribute("data-row-toggle", row.key);
    }
    box.setAttribute(
      "aria-label",
      row.completed ? i18n.t("tasks.row.completed") : i18n.t("tasks.row.notCompleted"),
    );
    el.appendChild(box);

    const text = document.createElement("span");
    text.className = row.completed ? "cm-task-query-text cm-task-query-text-done" : "cm-task-query-text";
    text.setAttribute("data-testid", "editor.task-query.text");
    text.textContent = row.text === "" ? i18n.t("tasks.row.untitled") : row.text;
    el.appendChild(text);

    if (row.due !== undefined) {
      const due = document.createElement("span");
      due.className = "cm-task-chip";
      due.setAttribute("data-testid", "editor.task-query.due");
      due.textContent = row.due;
      el.appendChild(due);
    }

    if (row.noteTitle !== null) {
      const note = document.createElement("button");
      note.type = "button";
      note.className = "cm-task-query-note";
      note.setAttribute("data-testid", "editor.task-query.note");
      note.setAttribute("data-row-open", row.key);
      note.textContent = row.noteTitle;
      el.appendChild(note);
    }
    return el;
  }

  ignoreEvent(): boolean {
    // The widget owns its own clicks and keys — the checkbox and the note
    // button are real controls.
    return false;
  }
}

/**
 * Build the block decorations.
 *
 * `focused` is an OPTIONAL override, and it exists for one reason: jsdom's focus
 * events are unreliable, so the reveal gate is untestable through a mounted
 * view. The table decoration hit this first and solved it the same way — a pure
 * `(state, focused)` builder the tests call directly. Production passes nothing
 * and the real focus field is read.
 */
export function buildTaskQueryDecorations(
  state: EditorState,
  focused?: boolean,
): DecorationSet {
  const results = state.field(taskQueryResultsField, false) ?? new Map();
  const builder = new RangeSetBuilder<Decoration>();
  for (const block of taskQueryBlocks(state)) {
    const fromLine = state.doc.lineAt(block.from);
    const toLine = state.doc.lineAt(block.to);
    // Whole-block reveal: a block widget is atomic, so revealing a fragment is
    // not expressible — and would not help, since the query is one unit.
    const revealed =
      focused === undefined
        ? linesRevealed(state, fromLine.number, toLine.number)
        : // Reading mode never reveals, whatever the focus state.
          focused &&
          !state.facet(readingModeFacet) &&
          selectionTouchesLines(state, fromLine.number, toLine.number);
    if (revealed) continue;
    builder.add(
      block.from,
      block.to,
      Decoration.replace({
        widget: new TaskQueryWidget(block.query, results.get(block.query), block.from),
        block: true,
      }),
    );
  }
  return builder.finish();
}

const taskQueryField = StateField.define<DecorationSet>({
  create: (state) => buildTaskQueryDecorations(state),
  update(deco, tr) {
    const selectionChanged = !tr.startState.selection.eq(tr.state.selection);
    const resultsChanged = tr.effects.some((e) => e.is(setTaskQueryResults));
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (
      tr.docChanged ||
      selectionChanged ||
      resultsChanged ||
      editorFocusChanged(tr) ||
      treeChanged
    ) {
      return buildTaskQueryDecorations(tr.state);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Row activation → a bubbling custom event the application listens for.
 *
 * A DOM event rather than a callback prop, for the same reason the tag chip uses
 * one: the widget has no route into the host's React context, and threading a
 * callback through the editor's configuration would add a host-interface member
 * for something the DOM already carries.
 */
const rowEvents = EditorView.domEventHandlers({
  mousedown(event, view) {
    return dispatchRowEvent(event, view);
  },
  keydown(event, view) {
    if (event.key !== "Enter" && event.key !== " ") return false;
    return dispatchRowEvent(event, view);
  },
});

function dispatchRowEvent(event: Event, view: EditorView): boolean {
  const target = event.target as HTMLElement | null;
  const toggle = target?.closest?.("[data-row-toggle]") as HTMLElement | null;
  const open = target?.closest?.("[data-row-open]") as HTMLElement | null;
  const hit = toggle ?? open;
  if (hit === null || hit === undefined) return false;
  const root = hit.closest("[data-query-key]") as HTMLElement | null;
  if (root === null) return false;

  event.preventDefault();
  const detail: TaskQueryRowEventDetail = {
    queryKey: root.getAttribute("data-query-key") ?? "",
    rowKey: (toggle ?? open)!.getAttribute(toggle !== null ? "data-row-toggle" : "data-row-open") ?? "",
  };
  view.dom.dispatchEvent(
    new CustomEvent<TaskQueryRowEventDetail>(
      toggle !== null ? TASK_QUERY_TOGGLE_EVENT : TASK_QUERY_OPEN_EVENT,
      { bubbles: true, detail },
    ),
  );
  return true;
}

export function taskQueryBlockDecorations(): readonly Extension[] {
  return [taskQueryResultsField, editorFocusField, editorFocusTracker, taskQueryField, rowEvents];
}
