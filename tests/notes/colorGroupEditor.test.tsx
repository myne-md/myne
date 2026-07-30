// @vitest-environment jsdom
//
// `<ColorGroupEditor>` (graph-connection-ux-polish task 7) — the color-group
// rule list inside the graph settings panel. Pins the authoring surface's own
// behaviour: add / rename / delete / enable-toggle / drag-reorder, the
// fixed-palette-only picker, the first-run empty state, and the props it hands
// the shared `<FilterBuilder>` (tag + folder leaves only — anything wider would
// let a user author a rule the task-3 evaluator silently degrades to no-match).
//
// Seams mocked: `usePrefs` (read) + `setColorGroups` (write), the sidebar note
// cache, and `<FilterBuilder>` itself — the real builder needs the run-view
// context and the vault indices, which say nothing about this component.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ColorGroup } from "../../src/lib/prefs";
import type { FilterDraft } from "../../src/notes/filterDraft";

let rules: ColorGroup[] = [];
const setColorGroups = vi.fn((next: ColorGroup[]) => {
  rules = next;
  return Promise.resolve();
});

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { color_groups: rules }, reload: vi.fn() }),
}));
vi.mock("../../src/lib/prefs", () => ({
  setColorGroups: (groups: ColorGroup[]) => setColorGroups(groups),
}));
vi.mock("../../src/notes/sidebarState", () => ({
  useSelectedNote: () => ({ cache: new Map() }),
}));

// jsdom can't drive the drag GEOMETRY (a synthetic DragEvent drops `clientY`
// and `getBoundingClientRect` reports a 0-rect), so the pure edge hit-test is
// mocked to a controllable value — the same treatment `folderRow.test.tsx`
// gives it. `dragEdge` itself is unit-tested elsewhere; what matters here is
// that the editor routes the resolved edge to the right insertion point.
let nextEdge: "above" | "below" = "below";
vi.mock("../../src/notes/components/reorderDnd", async (orig) => {
  const actual = await orig<typeof import("../../src/notes/components/reorderDnd")>();
  return { ...actual, dragEdge: () => nextEdge };
});

/** Captured props of the last `<FilterBuilder>` render, plus a Save hook so the
 *  draft→`FilterNode` mapping can be exercised without the real builder. */
let builderProps: {
  allowedTypes?: readonly string[];
  onSave: (draft: FilterDraft) => void;
  onCancel: () => void;
} | null = null;
vi.mock("../../src/notes/components/FilterBuilder", () => ({
  FilterBuilder: (props: {
    allowedTypes?: readonly string[];
    onSave: (draft: FilterDraft) => void;
    onCancel: () => void;
  }) => {
    builderProps = props;
    return <div data-testid="filter-builder-stub" />;
  },
}));

import { ColorGroupEditor } from "../../src/notes/components/ColorGroupEditor";

const rule = (over: Partial<ColorGroup> = {}): ColorGroup => ({
  id: "r1",
  name: "Work",
  color: "group-teal",
  enabled: true,
  filter: { kind: "all" },
  ...over,
});

/** The 8 task-4 categorical tokens, in the order the picker offers them. */
const PALETTE_KEYS = [
  "group-olive",
  "group-fern",
  "group-teal",
  "group-denim",
  "group-indigo",
  "group-violet",
  "group-orchid",
  "group-rose",
];

const rows = () => [...document.querySelectorAll('[data-testid="editor.color-group-row"]')];
const rowFor = (id: string) =>
  document.querySelector(`[data-testid="editor.color-group-row"][data-rule-id="${id}"]`)!;
const within = (id: string, testid: string) =>
  rowFor(id).querySelector(`[data-testid="${testid}"]`) as HTMLElement;
/** Last persisted list — the whole payload of every write (order IS precedence). */
const persisted = () => setColorGroups.mock.calls.at(-1)![0];

beforeEach(() => {
  rules = [];
  builderProps = null;
  nextEdge = "below";
  setColorGroups.mockClear();
  cleanup();
});

describe("ColorGroupEditor — empty state", () => {
  it("explains the feature and offers a first rule instead of a blank box", () => {
    render(<ColorGroupEditor />);
    const empty = screen.getByTestId("editor.color-groups-empty");
    expect(empty.textContent).toContain("No color groups yet");
    expect(empty.textContent).toContain("tag or folder");
    expect(screen.getByTestId("editor.color-group-add")).not.toBeNull();
    expect(document.querySelector('[data-testid="editor.color-groups-list"]')).toBeNull();
  });

  it("adds an enabled, first-palette-colored rule", () => {
    render(<ColorGroupEditor />);
    fireEvent.click(screen.getByTestId("editor.color-group-add"));
    expect(persisted()).toHaveLength(1);
    expect(persisted()[0]).toMatchObject({
      name: "",
      color: PALETTE_KEYS[0],
      enabled: true,
      filter: { kind: "all" },
    });
    expect(persisted()[0]!.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("appends a new rule at the end — last authored is lowest precedence", () => {
    rules = [rule({ id: "a" }), rule({ id: "b" })];
    render(<ColorGroupEditor />);
    fireEvent.click(screen.getByTestId("editor.color-group-add"));
    expect(persisted().map((r: ColorGroup) => r.id).slice(0, 2)).toEqual(["a", "b"]);
    expect(persisted()).toHaveLength(3);
  });
});

describe("ColorGroupEditor — rule list", () => {
  it("renders one row per rule, in list (precedence) order", () => {
    rules = [rule({ id: "a", name: "A" }), rule({ id: "b", name: "B" })];
    render(<ColorGroupEditor />);
    expect(rows().map((r) => r.getAttribute("data-rule-id"))).toEqual(["a", "b"]);
  });

  it("persists a renamed rule on blur, trimmed", () => {
    rules = [rule({ id: "a", name: "Old" })];
    render(<ColorGroupEditor />);
    const input = within("a", "editor.color-group-name") as HTMLInputElement;
    fireEvent.blur(input, { target: { value: "  Renamed  " } });
    expect(persisted()).toEqual([expect.objectContaining({ id: "a", name: "Renamed" })]);
  });

  it("does not write when the name is unchanged", () => {
    rules = [rule({ id: "a", name: "Same" })];
    render(<ColorGroupEditor />);
    fireEvent.blur(within("a", "editor.color-group-name"), { target: { value: "Same" } });
    expect(setColorGroups).not.toHaveBeenCalled();
  });

  it("retains a disabled rule in the list rather than dropping it", () => {
    rules = [rule({ id: "a" }), rule({ id: "b" })];
    render(<ColorGroupEditor />);
    fireEvent.click(within("a", "editor.color-group-enabled"));
    expect(persisted()).toHaveLength(2);
    expect(persisted()[0]).toMatchObject({ id: "a", enabled: false });
    expect(persisted()[1]).toMatchObject({ id: "b", enabled: true });
  });

  it("deletes only the targeted rule", () => {
    rules = [rule({ id: "a" }), rule({ id: "b" }), rule({ id: "c" })];
    render(<ColorGroupEditor />);
    fireEvent.click(within("b", "editor.color-group-delete"));
    expect(persisted().map((r: ColorGroup) => r.id)).toEqual(["a", "c"]);
  });
});

describe("ColorGroupEditor — palette picker", () => {
  it("offers exactly the 8 task-4 tokens and no free-form entry", () => {
    rules = [rule({ id: "a" })];
    render(<ColorGroupEditor />);
    fireEvent.click(within("a", "editor.color-group-swatch"));
    const picker = screen.getByTestId("editor.color-group-palette");
    const swatches = [...picker.querySelectorAll("[data-color-key]")];
    expect(swatches.map((s) => s.getAttribute("data-color-key"))).toEqual(PALETTE_KEYS);
    expect(picker.querySelector("input")).toBeNull();
  });

  it("persists the chosen token and closes the picker", () => {
    rules = [rule({ id: "a", color: "group-teal" })];
    render(<ColorGroupEditor />);
    fireEvent.click(within("a", "editor.color-group-swatch"));
    fireEvent.click(
      screen
        .getByTestId("editor.color-group-palette")
        .querySelector('[data-color-key="group-rose"]')!,
    );
    expect(persisted()).toEqual([expect.objectContaining({ id: "a", color: "group-rose" })]);
    expect(document.querySelector('[data-testid="editor.color-group-palette"]')).toBeNull();
  });
});

describe("ColorGroupEditor — filter authoring", () => {
  it("restricts the shared builder to the tag and folder leaves", () => {
    rules = [rule({ id: "a" })];
    render(<ColorGroupEditor />);
    fireEvent.click(within("a", "editor.color-group-edit-filter"));
    expect(screen.getByTestId("filter-builder-stub")).not.toBeNull();
    expect(builderProps!.allowedTypes).toEqual(["tag", "folder"]);
  });

  it("maps the saved draft onto that rule's filter and closes the builder", () => {
    rules = [rule({ id: "a" }), rule({ id: "b" })];
    render(<ColorGroupEditor />);
    fireEvent.click(within("a", "editor.color-group-edit-filter"));
    act(() =>
      builderProps!.onSave({
        combinator: "and",
        groups: [
          {
            combinator: "and",
            conditions: [{ type: "tag", value: "work", negated: false }],
          },
        ],
      }),
    );
    expect(persisted()[0]).toMatchObject({
      id: "a",
      filter: { kind: "hasTag", tag: "work" },
    });
    expect(persisted()[1]).toMatchObject({ id: "b", filter: { kind: "all" } });
    expect(document.querySelector('[data-testid="filter-builder-stub"]')).toBeNull();
  });

  it("cancelling writes nothing", () => {
    rules = [rule({ id: "a" })];
    render(<ColorGroupEditor />);
    fireEvent.click(within("a", "editor.color-group-edit-filter"));
    act(() => builderProps!.onCancel());
    expect(setColorGroups).not.toHaveBeenCalled();
  });
});

describe("ColorGroupEditor — drag to reorder (precedence)", () => {
  function dropOn(id: string, place: "above" | "below") {
    nextEdge = place;
    fireEvent.drop(rowFor(id));
  }

  it("moves a rule below its drop target", () => {
    rules = [rule({ id: "a" }), rule({ id: "b" }), rule({ id: "c" })];
    render(<ColorGroupEditor />);
    fireEvent.dragStart(rowFor("c"));
    dropOn("a", "below");
    expect(persisted().map((r: ColorGroup) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("moves a rule above its drop target", () => {
    rules = [rule({ id: "a" }), rule({ id: "b" }), rule({ id: "c" })];
    render(<ColorGroupEditor />);
    fireEvent.dragStart(rowFor("c"));
    dropOn("a", "above");
    expect(persisted().map((r: ColorGroup) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("dropping a rule on itself writes nothing", () => {
    rules = [rule({ id: "a" }), rule({ id: "b" })];
    render(<ColorGroupEditor />);
    fireEvent.dragStart(rowFor("a"));
    dropOn("a", "below");
    expect(setColorGroups).not.toHaveBeenCalled();
  });
});

describe("ColorGroupEditor — an unresolvable synced color key degrades", () => {
  // `ColorGroup.color` is SYNCED, peer-authorable content, so the row swatch
  // paints a value the local palette picker can never produce: a malformed key,
  // or a well-formed key naming a token this build does not define (a ninth
  // palette entry authored by a newer client). A bare `var(--x)` with no
  // fallback is invalid at computed-value time, so `background` falls back to
  // its INITIAL value — transparent — and the row shows an empty circle for a
  // rule the canvas is meanwhile painting neutral: two surfaces disagreeing
  // about the same key. `colorGroupVar` is the shared degrade both clients use.
  const swatchStyle = (color: string): string => {
    rules = [rule({ id: "r1", color })];
    render(<ColorGroupEditor />);
    return screen.getByTestId("editor.color-group-swatch").getAttribute("style") ?? "";
  };

  it("resolves a known palette key through its token, with a neutral fallback", () => {
    expect(swatchStyle("group-rose")).toContain("var(--group-rose, var(--accent))");
  });

  it("never composes a double-prefixed custom property from a `--`-prefixed key", () => {
    const style = swatchStyle("--group-rose");
    expect(style).not.toContain("var(----group-rose");
    expect(style).toContain("var(--accent)");
  });

  it("falls back to the neutral accent for a palette entry it cannot resolve", () => {
    // Well-formed, so it DOES reach `var()` — the fallback is what saves it.
    expect(swatchStyle("group-future")).toContain("var(--group-future, var(--accent))");
  });

  it("leaves the stored key untouched — the degrade is a render concern only", () => {
    // If an older client rewrote a key it merely failed to resolve, a round-trip
    // through it would destroy a newer client's rule.
    rules = [rule({ id: "r1", color: "group-future" })];
    render(<ColorGroupEditor />);
    fireEvent.click(screen.getByTestId("editor.color-group-name"));
    expect(setColorGroups).not.toHaveBeenCalled();
    expect(rules[0]!.color).toBe("group-future");
  });
});
