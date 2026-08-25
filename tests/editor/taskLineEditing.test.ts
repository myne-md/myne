// @vitest-environment jsdom
//
// Two task-line behaviours the live-preview editor got wrong, both driven
// through the FULL composed editor (`_conformance`'s `mount`) rather than
// against a hand-picked extension subset, because in both cases the defect was
// in the WIRING, and a subset mount would have been green while the app was not.
//
//   - myne-md/myne#562: a second Enter on an empty task item must leave a plain
//     line where the item was. `markdown()`'s default keymap slid the item down
//     a row instead and only removed it on a third press.
//   - myne-md/myne#563: the `- [ ]` run must lift back to source when the caret
//     is inside it, like every other construct. It never did: the decoration was
//     mounted on a plugin whose recompute gate does not watch the selection.

import { afterEach, describe, expect, it } from "vitest";
import { markdownKeymap } from "@codemirror/lang-markdown";
import { keymap } from "@codemirror/view";
import {
  type Mounted,
  focusAt,
  mount,
  query,
  queryAll,
  renderedText,
  teardown,
} from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

/** Press a key through the editor's own keymap, as the WebView would. */
function press(mounted: Mounted, key: string): void {
  mounted.view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

describe("Enter on a task line (myne-md/myne#562)", () => {
  it("continues the list on the first press", () => {
    m = mount("- [ ] a\n", 7);
    m.view.focus();
    press(m, "Enter");
    expect(m.view.state.doc.toString()).toBe("- [ ] a\n- [ ] \n");
  });

  it("leaves a PLAIN line on the second press, one row down", () => {
    // The whole bug in one assertion. The library default produced
    // "- [ ] a\n\n- [ ] \n" here: a blank line inserted ABOVE the empty item,
    // which is what "the checklist slid down two rows" was.
    m = mount("- [ ] a\n", 7);
    m.view.focus();
    press(m, "Enter");
    press(m, "Enter");
    expect(m.view.state.doc.toString()).toBe("- [ ] a\n\n");
    // …and the caret is ON that plain line, ready to type prose.
    expect(m.view.state.selection.main.head).toBe(8);
  });

  it("does not need a THIRD press to get there", () => {
    // The old third press is what removed the item, and by then the document
    // had a stray blank line in it that nobody asked for.
    m = mount("- [ ] a\n", 7);
    m.view.focus();
    press(m, "Enter");
    press(m, "Enter");
    const afterTwo = m.view.state.doc.toString();
    press(m, "Enter");
    expect(afterTwo).toBe("- [ ] a\n\n");
    expect(m.view.state.doc.toString()).toBe("- [ ] a\n\n\n");
  });

  it("still continues a plain bullet list", () => {
    // The configured command replaces the library's on BOTH chords; the
    // ordinary case must be untouched.
    m = mount("- a\n", 3);
    m.view.focus();
    press(m, "Enter");
    expect(m.view.state.doc.toString()).toBe("- a\n- \n");
  });

  it("keeps Backspace's markup deletion, which rides the same keymap", () => {
    // `addKeymap: false` declines the library's Enter AND its Backspace. If the
    // replacement had only re-declared Enter, this would silently be a plain
    // character delete.
    m = mount("- [ ] \n", 6);
    m.view.focus();
    press(m, "Backspace");
    expect(m.view.state.doc.toString()).toBe("\n");
  });
});

describe("task checkbox reveal (myne-md/myne#563)", () => {
  it("renders the checkbox and hides the marker with the caret elsewhere", () => {
    m = mount("- [ ] milk\nother\n", 12);
    expect(query(m, ".cm-task-checkbox")).not.toBeNull();
    expect(renderedText(m)).not.toContain("[ ]");
  });

  it("lifts the whole `- [ ]` run when the caret is inside the marker", () => {
    m = mount("- [ ] milk\nother\n");
    focusAt(m, 3); // inside `[ ]`
    expect(query(m, ".cm-task-checkbox")).toBeNull();
    // The bullet lifts WITH the marker: half-revealed source would be neither
    // the rendered form nor the document.
    expect(renderedText(m)).toContain("- [ ] milk");
  });

  it("keeps the checkbox while the caret is in the label", () => {
    // The reason this is per-range and not per-line: typing the label must not
    // make the checkbox disappear out from under the caret.
    m = mount("- [ ] milk\nother\n");
    focusAt(m, 9);
    expect(query(m, ".cm-task-checkbox")).not.toBeNull();
  });

  it("re-renders once the caret leaves", () => {
    m = mount("- [ ] milk\nother\n");
    focusAt(m, 3);
    expect(query(m, ".cm-task-checkbox")).toBeNull();
    focusAt(m, 13);
    expect(query(m, ".cm-task-checkbox")).not.toBeNull();
  });

  it("changes no bytes across a full focus cycle", () => {
    // §6 C1: the reveal is render-only. A cursor-aware decoration that edits is
    // the one failure mode worse than one that never lifts.
    const doc = "- [x] milk\n- [ ] eggs\n";
    m = mount(doc);
    focusAt(m, 0);
    focusAt(m, 3);
    focusAt(m, 8);
    focusAt(m, doc.length);
    expect(m.view.state.doc.toString()).toBe(doc);
  });
});

describe("a selection that covers the marker (myne-md/myne#560)", () => {
  it("shows the source instead of the checkbox", () => {
    // The checkbox paints an opaque accent fill. A translucent selection band
    // across it, beside the same band over plain text, is two tones in one
    // selection, the reported "double highlight". Showing `- [x] ` removes the
    // opaque surface rather than working around it, and it is the honest answer:
    // what is selected IS the markup.
    m = mount("- [x] Teachfluence\nother\n");
    m.view.focus();
    m.view.dispatch({ selection: { anchor: 0, head: 18 } });
    expect(query(m, ".cm-task-checkbox")).toBeNull();
    expect(renderedText(m)).toContain("- [x] Teachfluence");
  });

  it("keeps the checkbox for a selection of the label alone", () => {
    // Double-click selects a word, which never reaches the marker.
    m = mount("- [x] Teachfluence\nother\n");
    m.view.focus();
    m.view.dispatch({ selection: { anchor: 6, head: 18 } });
    expect(query(m, ".cm-task-checkbox")).not.toBeNull();
  });

  it("keeps the checkbox for a selection that merely ENDS where the run begins", () => {
    // Selecting the line above up to this line's start touches the boundary and
    // nothing else; the overlap test is strict at both ends for this case.
    m = mount("first\n- [x] Teachfluence\n");
    m.view.focus();
    m.view.dispatch({ selection: { anchor: 0, head: 6 } });
    expect(query(m, ".cm-task-checkbox")).not.toBeNull();
  });

  it("re-renders the checkbox once the selection moves off", () => {
    m = mount("- [x] Teachfluence\nother\n");
    m.view.focus();
    m.view.dispatch({ selection: { anchor: 0, head: 18 } });
    expect(query(m, ".cm-task-checkbox")).toBeNull();
    m.view.dispatch({ selection: { anchor: 19, head: 24 } });
    expect(query(m, ".cm-task-checkbox")).not.toBeNull();
  });

  it("changes no bytes doing it", () => {
    // The reveal is render-only. A selection-driven decoration that edits is the
    // one failure mode worse than one that never lifts.
    const doc = "- [x] milk\n- [ ] eggs\n";
    m = mount(doc);
    m.view.focus();
    m.view.dispatch({ selection: { anchor: 0, head: doc.length } });
    m.view.dispatch({ selection: { anchor: 3, head: 3 } });
    expect(m.view.state.doc.toString()).toBe(doc);
  });
});

describe("triple-click on a list row (myne-md/myne#560)", () => {
  /** What CM6 dispatches for a triple-click: the line PLUS its trailing break. */
  const tripleClick = (from: number, to: number) => {
    m!.view.dispatch({ selection: { anchor: from, head: to }, userEvent: "select.pointer" });
  };

  it("keeps the caret on the row that was clicked", () => {
    // Untrimmed, `range.to` is the NEXT line's start: the caret lands a row below
    // the row the user clicked and the band is drawn across both.
    m = mount("- [x] Teachfluence\nother\n");
    m.view.focus();
    tripleClick(0, 19);
    const main = m.view.state.selection.main;
    expect(main.to).toBe(18);
    expect(m.view.state.doc.lineAt(main.head).number).toBe(1);
  });

  it("still selects the WHOLE row, hidden marker included", () => {
    m = mount("- [x] Teachfluence\nother\n");
    m.view.focus();
    tripleClick(0, 19);
    expect(m.view.state.selection.main.from).toBe(0);
    // …and the marker renders as source under it, so no band lands on the
    // checkbox's opaque fill.
    expect(query(m, ".cm-task-checkbox")).toBeNull();
  });

  it("works on an EMPTY task row too", () => {
    // The row shape nothing tested. `listContentStart` answers `null` where the
    // marker IS the whole line, so keying the trim off it left an empty `- [ ] `
    // untrimmed and the caret a row below, the defect the trim exists to fix,
    // reintroduced on the one row it could not see. `listMarkerEnd` is the check
    // that does not require content.
    m = mount("- [ ] \nother\n");
    m.view.focus();
    tripleClick(0, 7);
    const main = m.view.state.selection.main;
    expect(main.to).toBe(6);
    expect(m.view.state.doc.lineAt(main.head).number).toBe(1);
  });

  it("leaves a plain prose row alone", () => {
    // The reasoning is about a row drawn as a widget; prose has none, and
    // trimming there would change a standard gesture for no reason.
    m = mount("just some prose\nother\n");
    m.view.focus();
    tripleClick(0, 16);
    expect(m.view.state.selection.main.to).toBe(16);
  });

  it("leaves a KEYBOARD selection of the same shape alone", () => {
    m = mount("- [x] Teachfluence\nother\n");
    m.view.focus();
    m.view.dispatch({ selection: { anchor: 0, head: 19 }, userEvent: "select" });
    expect(m.view.state.selection.main.to).toBe(19);
  });

  it("leaves a selection spanning more than one row alone", () => {
    m = mount("- [x] Teachfluence\nother\nthird\n");
    m.view.focus();
    tripleClick(0, 24);
    expect(m.view.state.selection.main.to).toBe(24);
  });
});

describe("the `+` add-field affordance (myne-md/myne#560)", () => {
  it("appears for a caret on the row", () => {
    m = mount("- [ ] milk\nother\n");
    focusAt(m, 8);
    expect(query(m, ".cm-task-add")).not.toBeNull();
  });

  it("does NOT appear while text on that row is selected", () => {
    // It enters the line's DOM in the same update that moves the selection, so
    // `drawSelection` can measure the row mid-change and paint the two-rectangle
    // form: one band to the right edge, one from the left edge, doubling a
    // translucent wash where they overlap. Nothing recomputes it afterwards.
    m = mount("- [ ] milk\nother\n");
    m.view.focus();
    m.view.dispatch({ selection: { anchor: 6, head: 10 } });
    expect(query(m, ".cm-task-add")).toBeNull();
  });

  it("comes back when the selection collapses again", () => {
    m = mount("- [ ] milk\nother\n");
    m.view.focus();
    m.view.dispatch({ selection: { anchor: 6, head: 10 } });
    expect(query(m, ".cm-task-add")).toBeNull();
    m.view.dispatch({ selection: { anchor: 8, head: 8 } });
    expect(query(m, ".cm-task-add")).not.toBeNull();
  });
});

describe("the markdown keymap we took over (myne-md/myne#562)", () => {
  it("still covers everything the library would have installed", () => {
    // `markdown({ addKeymap: false })` declines the library's keymap and this
    // repo re-declares it. That freezes a SNAPSHOT: a lang-markdown minor adding
    // a third binding lands here as a feature that silently never arrives, with
    // nothing red. Two is the count in 6.5.0; if this fails, read the new
    // binding and decide whether to adopt it, do not just bump the number.
    expect(markdownKeymap).toHaveLength(2);
    expect(markdownKeymap.map((b) => b.key).sort()).toEqual(["Backspace", "Enter"]);
  });
});

describe("the state the e2e/ scenarios leave the editor in (myne-md/myne#560)", () => {
  // `e2e/task-recurrence.e2e.ts` and `e2e/task-query-block.e2e.ts` both count and
  // click `editor.task-checkbox`. The reveal added here moves that element, so
  // the question is whether either scenario can end up in a state where it is
  // gone. Both type a task line and then reach for the checkbox, which leaves the
  // caret at the END of the label, and neither ever selects. These pin that, so
  // the answer stops depending on reading two scenario files correctly.

  it("keeps the checkbox after typing a task line, caret at the end", () => {
    // `typeIntoEditor(s, "- [ ] water the plants")` then `byTestId(...)`.
    const doc = "- [ ] water the plants\n";
    m = mount(doc, doc.length - 1);
    m.view.focus();
    expect(query(m, ".cm-task-checkbox")).not.toBeNull();
  });

  it("keeps every checkbox when several task lines exist and the caret is on one", () => {
    // `taskCount()` counts them all after the tick materialises a successor.
    const doc = "- [x] water the plants\n- [ ] water the plants\nother\n";
    m = mount(doc, 20);
    m.view.focus();
    expect(queryAll(m, ".cm-task-checkbox")).toHaveLength(2);
  });

  it("keeps the checkbox with the editor unfocused, which is where a click starts", () => {
    const doc = "- [ ] water the plants\n";
    m = mount(doc, 3); // caret INSIDE the marker, but nothing focused
    expect(query(m, ".cm-task-checkbox")).not.toBeNull();
  });
});

describe("the composed editor really mounts the line-boundary chords", () => {
  it("carries Cmd+Backspace and Cmd+Delete in its keymap facet", () => {
    // `lineBoundarySmartHome.test.ts` asserts the exported ARRAY holds them,
    // which a perfect array nobody composes satisfies just as well: deleting the
    // one `...lineBoundaryKeymap` spread from `extensions.ts` removes both new
    // destructive chords AND the movement pair, and the whole suite stays green.
    // This reads the facet the mounted editor actually resolved, so the
    // registration is what is checked rather than the declaration. Facet, not a
    // synthetic keypress, because the bindings are `mac:`-only and the E2E lane
    // is Linux, so a keypress test would pass by never firing.
    m = mount("- [ ] a\n");
    const bound = m.view.state
      .facet(keymap)
      .flat()
      .map((b) => b.mac)
      .filter((k): k is string => typeof k === "string");
    expect(bound).toContain("Cmd-Backspace");
    expect(bound).toContain("Cmd-Delete");
    expect(bound).toContain("Cmd-ArrowLeft");
    expect(bound).toContain("Cmd-ArrowRight");
  });
});
