// @vitest-environment jsdom
//
// `<Icon>` keeps its DOM nodes across a re-render (myne-md/myne#894).
//
// **The defect this pins is invisible and it kills controls.** React 19's
// reconciler compares `dangerouslySetInnerHTML` by OBJECT identity, not by the
// `__html` string (`react-dom-client`'s `updateProperties`, the
// `for (lastProp in nextProps)` loop, which skips a prop only when
// `nextValue === prevValue`). So an inline `={{ __html: … }}` literal makes
// React re-assign `domElement.innerHTML` on EVERY render, which replaces the
// `<path>` nodes under the `<svg>`. Nothing the eye can catch changes; what
// breaks is the click: the browser dispatches no `click` event when the
// mousedown and mouseup targets are different nodes, so any control whose icon
// re-renders between press and release does NOTHING.
//
// Measured, not reasoned, on the agent hub's "New conversation"
// (`agent-hub` ah5): pointerdown landed on the icon's path, the `Tooltip`'s own
// mousedown/focus state change re-rendered the icon, the path node was replaced
// BEFORE mouseup, and no click event was dispatched at all. A scripted
// `element.click()` still worked, which is exactly why this read as a
// test-harness problem. The scenario only passed once the icon stopped
// rebuilding itself mid-press.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Icon } from "../../src/components/primitives/Icon";

afterEach(() => cleanup());

describe("the icon's own nodes survive a re-render", () => {
  it("keeps the same <path> node when an unrelated prop changes", () => {
    const { container, rerender } = render(<Icon name="plus" />);
    const first = container.querySelector("path");
    expect(first, "the plus glyph renders at least one path").not.toBeNull();

    // A re-render with a different `size`: React must reconcile in place. A
    // fresh `{__html}` object here is what made the old code assign
    // `innerHTML`, which detaches `first` and mounts a new node in its place.
    rerender(<Icon name="plus" size={15} />);

    const second = container.querySelector("path");
    expect(
      second,
      "the <path> node was REPLACED by the re-render: an inline " +
        "`dangerouslySetInnerHTML={{ __html: … }}` re-assigns innerHTML on " +
        "every render, because React compares that prop by identity. A press " +
        "straddling a re-render then dispatches no click at all",
    ).toBe(first);
  });

  it("keeps the same node for a glyph whose body is several paths", () => {
    // `plus` is two paths; `circle`-family glyphs and the daily-note calendar
    // are many. The identity must hold for the whole fragment, not one lucky
    // single-child case.
    const { container, rerender } = render(<Icon name="calendar" />);
    const before = [...container.querySelectorAll("path,rect,circle,line")];
    expect(before.length).toBeGreaterThan(1);

    rerender(<Icon name="calendar" strokeWidth={2} />);

    const after = [...container.querySelectorAll("path,rect,circle,line")];
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i], `child ${i} was rebuilt`).toBe(before[i]);
    }
  });
});

describe("no call site hands React a fresh {__html} object", () => {
  /**
   * The regression test above covers `<Icon>`. This covers the CLASS: the same
   * one-line literal in any other component is the identical defect, and there
   * were four sites when this landed (`Icon`, `PanelToggleGlyph`, and the
   * desktop/mobile `FolderGlyph` twins). A source scan is what stops a fifth.
   *
   * The rule is deliberately syntactic: an inline object literal is the shape
   * that goes stale, and an identifier hoisted per glyph name is the shape that
   * does not.
   */
  const ROOTS = [
    "src",
    "mobile/src",
    "web/src",
    "editor/src",
    "dialect/src",
    "client-core/src",
    "ornaments/src",
  ];

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("every dangerouslySetInnerHTML receives an identifier, never a literal", () => {
    // `process.cwd()`, the idiom the other tree-scanning specs use
    // (`tests/scripts/clipperIdentifiers.test.ts`): vitest runs from the repo
    // root, and `import.meta.dirname` is not in the test trees' type surface.
    const repoRoot: string = process.cwd();
    const files = ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root)));
    // A scan whose denominator is empty prints nothing and passes forever.
    expect(files.length, "the scan found no source files").toBeGreaterThan(200);

    const offenders: string[] = [];
    for (const file of files) {
      const text: string = readFileSync(file, "utf8");
      // `={{` is the inline literal; `={` is the hoisted object it must be.
      const re = /dangerouslySetInnerHTML=\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (text.startsWith("{{", m.index + "dangerouslySetInnerHTML=".length)) {
          const line = text.slice(0, m.index).split("\n").length;
          offenders.push(`${relative(repoRoot, file)}:${line}`);
        }
      }
    }

    expect(
      offenders,
      "these hand React a NEW {__html} object on every render, so React " +
        "re-assigns innerHTML and replaces the SVG nodes: a press that " +
        "straddles a re-render dispatches no click, and the control is dead. " +
        "Hoist one frozen object per glyph (see `Icon.tsx::innerHtmlFor`)",
    ).toEqual([]);
  });
});
