// @vitest-environment jsdom
//
// Plain list rendering (MYND-208, task 4). Off-cursor: `-`/`*`/`+` → muted
// bullet glyph (`•` top level, `◦` nested), ordered `n.` muted; cursor-aware
// reveal of the raw marker; task items left to task-list.ts; byte-stable.

import { afterEach, describe, expect, it } from "vitest";
import {
  type Mounted,
  focusAt,
  mount,
  query,
  renderedText,
  roundTripBytes,
  teardown,
} from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("bullet lists", () => {
  it("renders a top-level bullet (filled disc) and hides the raw marker off-cursor", () => {
    m = mount("- first\n- second\n");
    const bullet = query(m, ".cm-list-bullet");
    expect(bullet).not.toBeNull();
    // CSS-drawn disc → no glyph text, and not the nested ring variant.
    expect(bullet!.classList.contains("cm-list-bullet-ring")).toBe(false);
    // The raw `-` marker is replaced; the rendered line shows the body text.
    expect(renderedText(m)).toContain("first");
  });

  it("uses the hollow ring variant for a nested bullet", () => {
    m = mount("- top\n  - nested\n");
    const top = m.host.querySelector(".cm-list-bullet:not(.cm-list-bullet-ring)");
    const ring = m.host.querySelector(".cm-list-bullet-ring");
    expect(top).not.toBeNull();
    expect(ring).not.toBeNull();
  });

  it("applies the hanging-indent line class to list lines", () => {
    m = mount("- item\n");
    expect(query(m, ".cm-list-item-line")).not.toBeNull();
  });

  it("keeps the bullet rendered (raw `-` NOT revealed) with the caret in the item text", () => {
    // Marker-scoped reveal: editing the item's text keeps the disc — the raw
    // `- ` no longer flickers back whenever the caret is anywhere on the line.
    m = mount("- item here\n");
    focusAt(m, 3); // caret in the text, not on the marker
    expect(renderedText(m)).not.toContain("- item here");
    expect(renderedText(m)).toContain("item here");
    expect(query(m, ".cm-list-bullet")).not.toBeNull();
  });

  it("reveals the raw `-` when the caret is ON the marker", () => {
    // Like a heading's `#`: bring the caret onto the marker itself and the raw
    // `- ` shows for editing.
    m = mount("- item here\n");
    focusAt(m, 0); // caret on the marker (line start)
    expect(renderedText(m)).toContain("- item here");
    expect(query(m, ".cm-list-bullet")).toBeNull();
  });
});

describe("ordered lists", () => {
  it("mutes the number marker but keeps it visible", () => {
    m = mount("1. first\n2. second\n");
    const num = query(m, ".cm-list-number");
    expect(num).not.toBeNull();
    expect(renderedText(m)).toContain("1.");
  });
});

describe("task items are left to task-list.ts", () => {
  it("does not add a bullet glyph to a task item", () => {
    m = mount("- [ ] todo\n");
    expect(query(m, ".cm-list-bullet")).toBeNull();
    expect(query(m, ".cm-task-checkbox")).not.toBeNull();
  });

  it("renders a bullet, not a checkbox, when the marker has no separator", () => {
    // `- [ ]foo` is an ordinary bullet item whose text starts with `[ ]`, and the
    // parser's task rule requires the space. Both decorations have to agree on
    // that or the line renders with no marker at all (myne-md/myne#594).
    m = mount("- [ ]foo\n");
    expect(query(m, ".cm-task-checkbox")).toBeNull();
    expect(query(m, ".cm-list-bullet")).not.toBeNull();
  });
});

/** Whitespace and the trailing `;` are the DOM's, not ours. */
const norm = (style: string): string =>
  style.replace(/\s+/g, "").replace(/;$/, "");

/** The expected declaration, put through the SAME serialiser the rendered line
 *  went through: it rewrites `calc()` operand order, so comparing a
 *  hand-written string would be testing jsdom's CSS writer, not the decoration. */
function styleOf(declaration: string): string {
  const probe = document.createElement("div");
  probe.style.cssText = declaration; // the path CM6 applies line attributes through
  return norm(probe.getAttribute("style") ?? "");
}

/** The last LIST line. Scoped to list lines rather than to `.cm-line`, because a
 *  doc ending in a newline renders a trailing empty line that belongs to no
 *  item. */
function lastListLine(mm: Mounted): HTMLElement | null {
  const lines = Array.from(
    mm.host.querySelectorAll<HTMLElement>(".cm-list-item-line"),
  );
  return lines[lines.length - 1] ?? null;
}

/** Its inline style, and the text it actually paints. */
const lineBox = (mm: Mounted): string | null => {
  const line = lastListLine(mm);
  return line === null ? null : norm(line.getAttribute("style") ?? "");
};
const lineText = (mm: Mounted): string | null =>
  lastListLine(mm)?.textContent ?? null;

describe("hanging indent (myne-md/myne#594)", () => {
  it("measures a task line against the checkbox", () => {
    m = mount("- [ ] a task label\n");
    // 22px = `.cm-task-checkbox` 16px + its 6px margin. No indent step: the item
    // is top level.
    expect(lineBox(m)).toBe(
      styleOf(
        "text-indent:calc(-1 * var(--cm-list-marker-task, 22px));padding-left:calc(var(--cm-line-lead, 0px) + 0 * var(--cm-list-indent-step, 1.5em) + var(--cm-list-marker-task, 22px) + 6px)",
      ),
    );
  });

  it("measures a bullet line against the disc", () => {
    m = mount("- a bullet label\n");
    expect(lineBox(m)).toBe(
      styleOf(
        "text-indent:calc(-1 * var(--cm-list-marker-bullet, 1.4ch));padding-left:calc(var(--cm-line-lead, 0px) + 0 * var(--cm-list-indent-step, 1.5em) + var(--cm-list-marker-bullet, 1.4ch) + 6px)",
      ),
    );
  });

  it("measures an ordered line against its own marker and gap", () => {
    m = mount("1. an ordered label\n");
    expect(lineBox(m)).toBe(
      styleOf(
        "text-indent:calc(-1 * 3ch);padding-left:calc(var(--cm-line-lead, 0px) + 0 * var(--cm-list-indent-step, 1.5em) + 3ch + 6px)",
      ),
    );
  });

  it("adds ONE indent step per nesting level, whatever the source spacing", () => {
    m = mount("- parent\n  - [ ] two-space nest\n");
    expect(lineBox(m)).toBe(
      styleOf(
        "text-indent:calc(-1 * var(--cm-list-marker-task, 22px));padding-left:calc(var(--cm-line-lead, 0px) + 1 * var(--cm-list-indent-step, 1.5em) + var(--cm-list-marker-task, 22px) + 6px)",
      ),
    );
    teardown(m);
    // Four spaces, same level, same column, which is the normalisation.
    m = mount("- parent\n    - [ ] four-space nest\n");
    expect(lineBox(m)).toBe(
      styleOf(
        "text-indent:calc(-1 * var(--cm-list-marker-task, 22px));padding-left:calc(var(--cm-line-lead, 0px) + 1 * var(--cm-list-indent-step, 1.5em) + var(--cm-list-marker-task, 22px) + 6px)",
      ),
    );
  });

  it("hides the source indent the padding now stands for", () => {
    m = mount("- parent\n  - [ ] nested task\n");
    // Nothing of the marker's run is painted: the indent is the padding, and the
    // separator after `[ ]` is the checkbox's own margin (`task-list.ts`), so
    // the label starts exactly where the padding says it does.
    expect(lineText(m)).toBe("nested task");
  });

  it("hides it on an EMPTY nested item too, so it keeps its siblings' column", () => {
    // What is left is the separator the bullet's own replacement stops short of
    // one character of real text, which is what an empty item needs to have
    // somewhere to type (myne-md/myne#598).
    m = mount("- parent\n  - ");
    expect(lineText(m)).toBe(" ");
  });

  it("keeps it when the marker is the last thing on the line", () => {
    // `  -` with nothing after it: hiding the indent as well would leave the
    // line with no text node at all, which is #598 exactly.
    m = mount("- parent\n  -");
    expect(lineText(m)).toBe("  ");
  });

  it("gives every list line a box", () => {
    m = mount("- [ ] one\n  - [x] two\n- three\n1. four\n");
    expect(m.host.querySelectorAll(".cm-list-item-line")).toHaveLength(4);
  });
});

/** The text nodes of the last rendered line, in order: what the browser has to
 *  put a typed character into. A line made only of widgets has none. */
function lastLineTextNodes(mm: Mounted): string[] {
  const lines = Array.from(mm.host.querySelectorAll(".cm-line"));
  const last = lines[lines.length - 1] as HTMLElement;
  return Array.from(last.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? "");
}

describe("an empty item keeps an editable position (myne-md/myne#598)", () => {
  it("leaves the separator of a top-level empty item as text", () => {
    // Without this the line's DOM is widget-only, and a character typed into it
    // has nowhere to land: the WebView attributes it to the widget's start, so
    // the letter appears BEFORE the marker and the item stops being a list item.
    m = mount("- one\n- ");
    expect(lastLineTextNodes(m).join("")).not.toBe("");
  });

  it("still swallows the separator when the item has text", () => {
    // The label is inside its own box now, so read the line's whole text: what
    // this pins is that no leading space survived the marker's replacement.
    m = mount("- one\n- item");
    const lines = Array.from(m.host.querySelectorAll(".cm-line"));
    expect((lines[lines.length - 1] as HTMLElement).textContent).toBe("item");
  });

  it("a nested empty item already had its indent as text, and keeps it", () => {
    m = mount("- one\n  - ");
    expect(lastLineTextNodes(m).join("")).not.toBe("");
  });

  it("renders the disc either way", () => {
    m = mount("- one\n- ");
    expect(query(m, ".cm-list-bullet")).not.toBeNull();
  });
});

describe("byte stability", () => {
  it("round-trips bullet, ordered, nested and task lists unchanged", () => {
    const doc = "- a\n- b\n  - c\n\n1. one\n2. two\n\n- [ ] t\n- [x] d\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });
});

describe("the padding and the hidden indent agree", () => {
  it("drops the indent step when the source indent stays visible", () => {
    // The padding stands IN for the source indent, and hiding it is gated: a
    // line whose marker is the last thing on it keeps its text, or the `.cm-line`
    // would have no text node for a typed character to land in (myne#598). The
    // padding was not gated with it, so on that line the spaces were painted AND
    // the same step was added again, and the row sat one level further in than
    // its siblings. A nested `-` alone on its line is that case.
    m = mount("- a\n  -");
    const box = lineBox(m);
    expect(box).not.toBeNull();
    // Depth 1, but the step is written as 0 because the indent is still there.
    expect(box).toContain("0*var(--cm-list-indent-step,1.5em)");
    // …and the indent really is still painted, which is the premise.
    expect(lineText(m)).toContain("  ");
  });

  it("keeps the indent step when the indent IS hidden", () => {
    // The other direction, so the fix cannot be "always 0".
    m = mount("- a\n  - nested label\n");
    expect(lineBox(m)).toContain("1*var(--cm-list-indent-step,1.5em)");
    expect(lineText(m)?.startsWith("  ")).toBe(false);
  });
});
