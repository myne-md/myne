// @vitest-environment jsdom
//
// Materialize on completion, and remove the orphan on un-tick
// (MYND-615, tasks 7 and 9).
//
// The properties worth testing are the ones that would be invisible when broken:
// ONE transaction (so one undo restores everything), materialization only on the
// unticked→ticked edge (so a double click cannot duplicate), and a splice rather
// than a re-serialization (so an imported note's bytes stay put).

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { parser } from "../../src/dialect/lezer/parser";
import {
  completeRecurringTask,
  nextOccurrenceLine,
  skipOccurrence,
  uncompleteRecurringTask,
  type Clock,
} from "@myne/editor/decorations/task-recurrence";

const TODAY: Clock = () => ({ year: 2026, month: 7, day: 28 });

function mount(doc: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: { parser } as never }), history()],
    }),
  });
  return { view, host };
}

function teardown(view: EditorView, host: HTMLElement) {
  view.destroy();
  host.remove();
}

/** Offset of the `[ ]`/`[x]` marker on the first line. */
function markerAt(view: EditorView, lineNumber = 1): number {
  const line = view.state.doc.line(lineNumber);
  return line.from + line.text.indexOf("[");
}

describe("the next-occurrence line", () => {
  it("advances the due date and clears the completion field", () => {
    const out = nextOccurrenceLine(
      "- [x] pay rent [due:: 2026-07-01] [repeat:: every month] [done:: 2026-07-28]",
      { year: 2026, month: 7, day: 28 },
    );
    expect(out).toContain("[due:: 2026-08-01]");
    expect(out).not.toContain("done::");
  });

  it("comes back unticked — the next occurrence has not happened", () => {
    const out = nextOccurrenceLine(
      "- [X] x [due:: 2026-07-01] [repeat:: every month]",
      { year: 2026, month: 7, day: 28 },
    );
    expect(out!.startsWith("- [ ]")).toBe(true);
  });

  it("keeps the description text", () => {
    const out = nextOccurrenceLine(
      "- [x] pay the rent to the landlord [due:: 2026-07-01] [repeat:: every month]",
      { year: 2026, month: 7, day: 28 },
    );
    expect(out).toContain("pay the rent to the landlord");
  });

  it("returns null for a task with no rule", () => {
    expect(nextOccurrenceLine("- [x] one-off [due:: 2026-07-01]", TODAY())).toBeNull();
  });

  it("returns null for an UNRECOGNIZED rule rather than inventing a default", () => {
    // A rule Myne cannot read must look unread. Materializing "every day" here
    // would repeat a task the user never asked to repeat.
    expect(
      nextOccurrenceLine("- [x] x [due:: 2026-07-01] [repeat:: every fortnight]", TODAY()),
    ).toBeNull();
  });
});

describe("materialization rides ONE transaction (task 7)", () => {
  it("flips the marker and inserts the occurrence in a single dispatch", () => {
    const { view, host } = mount("- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n");
    const seen: (string | undefined)[] = [];
    const original = view.dispatch.bind(view);
    // @ts-expect-error - test seam
    view.dispatch = (...specs) => {
      for (const spec of specs) seen.push((spec as { userEvent?: string }).userEvent);
      return original(...(specs as never));
    };

    expect(completeRecurringTask(view, markerAt(view), TODAY)).toBe(true);
    expect(seen).toEqual(["myne.task-recurrence.materialize"]);
    expect(view.state.doc.lines).toBe(3); // two task lines + trailing empty
    teardown(view, host);
  });

  it("one undo restores the document byte-for-byte", () => {
    const before = "- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n";
    const { view, host } = mount(before);
    completeRecurringTask(view, markerAt(view), TODAY);
    expect(view.state.doc.toString()).not.toBe(before);

    undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
    expect(view.state.doc.toString()).toBe(before);
    teardown(view, host);
  });

  it("materializes only on the unticked→ticked edge", () => {
    const { view, host } = mount("- [x] pay rent [due:: 2026-07-01] [repeat:: every month]\n");
    // Already ticked: nothing to materialize.
    expect(completeRecurringTask(view, markerAt(view), TODAY)).toBe(false);
    expect(view.state.doc.lines).toBe(2);
    teardown(view, host);
  });

  it("a rapid double click yields no duplicate occurrence", () => {
    // The document is the idempotency key: the second call reads a ticked marker
    // and declines. No side table, no guard flag.
    const { view, host } = mount("- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n");
    expect(completeRecurringTask(view, markerAt(view), TODAY)).toBe(true);
    expect(completeRecurringTask(view, markerAt(view), TODAY)).toBe(false);
    const occurrences = view.state.doc.toString().split("pay rent").length - 1;
    expect(occurrences).toBe(2);
    teardown(view, host);
  });

  it("is a splice — surrounding lines are untouched", () => {
    const { view, host } = mount(
      "# Heading\n\n- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n\nTrailing prose.\n",
    );
    const line = view.state.doc.line(3);
    completeRecurringTask(view, line.from + line.text.indexOf("["), TODAY);
    const out = view.state.doc.toString();
    expect(out.startsWith("# Heading\n\n")).toBe(true);
    expect(out.endsWith("\nTrailing prose.\n")).toBe(true);
    teardown(view, host);
  });
});

describe("orphan removal on un-tick (task 9)", () => {
  function completed() {
    const { view, host } = mount("- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n");
    completeRecurringTask(view, markerAt(view), TODAY);
    return { view, host };
  }

  it("removes the occurrence it created, in the same transaction as the un-tick", () => {
    const { view, host } = completed();
    const before = view.state.doc.toString();
    expect(uncompleteRecurringTask(view, markerAt(view), TODAY)).toBe(true);
    expect(view.state.doc.toString()).not.toBe(before);
    expect(view.state.doc.toString()).toContain("- [ ] pay rent");
    expect(view.state.doc.lines).toBe(2);
    teardown(view, host);
  });

  it("one undo restores both halves", () => {
    const { view, host } = completed();
    const afterComplete = view.state.doc.toString();
    uncompleteRecurringTask(view, markerAt(view), TODAY);
    undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
    expect(view.state.doc.toString()).toBe(afterComplete);
    teardown(view, host);
  });

  it("leaves a line it cannot positively identify ALONE", () => {
    // The conservative half of the heuristic: deleting user content on a guess
    // fails rarely but fails unrecoverably.
    const { view, host } = completed();
    // The user edited the generated line — it is now their content.
    const second = view.state.doc.line(2);
    view.dispatch({ changes: { from: second.from, to: second.to, insert: "- [ ] my own note" } });

    expect(uncompleteRecurringTask(view, markerAt(view), TODAY)).toBe(false);
    expect(view.state.doc.toString()).toContain("my own note");
    teardown(view, host);
  });

  it("leaves a TICKED next line alone", () => {
    const { view, host } = completed();
    const second = view.state.doc.line(2);
    view.dispatch({
      changes: { from: second.from, to: second.to, insert: second.text.replace("[ ]", "[x]") },
    });
    expect(uncompleteRecurringTask(view, markerAt(view), TODAY)).toBe(false);
    teardown(view, host);
  });

  it("declines when there is no next line at all", () => {
    const { view, host } = mount("- [x] pay rent [due:: 2026-07-01] [repeat:: every month]");
    expect(uncompleteRecurringTask(view, markerAt(view), TODAY)).toBe(false);
    teardown(view, host);
  });
});

describe("skip (task 8)", () => {
  it("advances the date without adding a line", () => {
    const { view, host } = mount("- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n");
    expect(skipOccurrence(view, markerAt(view), TODAY)).toBe(true);
    expect(view.state.doc.lines).toBe(2); // unchanged: updated in place
    expect(view.state.doc.toString()).toContain("[due:: 2026-08-01]");
    teardown(view, host);
  });

  it("writes NO completion field — the occurrence did not happen", () => {
    const { view, host } = mount("- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n");
    skipOccurrence(view, markerAt(view), TODAY);
    expect(view.state.doc.toString()).not.toContain("done::");
    teardown(view, host);
  });

  it("leaves the marker unticked — a ticked marker would be a lie", () => {
    const { view, host } = mount("- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n");
    skipOccurrence(view, markerAt(view), TODAY);
    expect(view.state.doc.toString()).toContain("- [ ] pay rent");
    teardown(view, host);
  });

  it("leaves no record of the skip — that would be per-occurrence history", () => {
    const { view, host } = mount("- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n");
    skipOccurrence(view, markerAt(view), TODAY);
    const out = view.state.doc.toString();
    expect(out.toLowerCase()).not.toContain("skip");
    teardown(view, host);
  });

  it("one undo restores the original line", () => {
    const before = "- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n";
    const { view, host } = mount(before);
    skipOccurrence(view, markerAt(view), TODAY);
    undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
    expect(view.state.doc.toString()).toBe(before);
    teardown(view, host);
  });

  it("declines on a task with no rule", () => {
    const { view, host } = mount("- [ ] one-off [due:: 2026-07-01]\n");
    expect(skipOccurrence(view, markerAt(view), TODAY)).toBe(false);
    teardown(view, host);
  });

  it("declines on an unrecognized rule", () => {
    const { view, host } = mount("- [ ] x [due:: 2026-07-01] [repeat:: every fortnight]\n");
    expect(skipOccurrence(view, markerAt(view), TODAY)).toBe(false);
    teardown(view, host);
  });
});
