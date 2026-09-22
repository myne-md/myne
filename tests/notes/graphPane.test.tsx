// @vitest-environment jsdom
//
// The graph PANE mounts without throwing (myne-md/myne#727).
//
// This exists because the failure it catches is not catchable any other way.
// `RootErrorBoundary` wraps the whole app, so an exception thrown while the
// graph pane renders, or inside one of its effects, which React 18+ also
// routes to the boundary, replaces the entire workspace with the fail-closed
// card ("Unexpected state. Please restart."). tsc, every guard and every pure
// unit test stay green through that: the throw is a runtime one, in a tree that
// only exists once the pane is mounted with real-ish prefs, a real tag tree and
// real rules. So this spec mounts the pane and asserts it renders.
//
// The tag-node path (task 18) is the part with the most new moving pieces, a
// state derived from an effect that itself reads a ref, a memo that merges two
// models, and a list that now takes two callbacks, so the cases below drive
// the rule shapes that change what the pane is asked to draw.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GraphModel } from "../../src/notes/graphModel";
import type { ColorGroup } from "../../src/lib/prefs";

const NOTES = [
  { noteUuid: "n-a", title: "Alpha", folder: null },
  { noteUuid: "n-b", title: "Bravo", folder: null },
];



/** The rules the pane reads. Reassigned per test so the same mount path can be
 *  driven with no rules, a bare `hasTag` rule (which claims a TAG NODE) and a
 *  combinator (which must not). */
let colorGroups: ColorGroup[] = [];

const byTagCalls: string[] = [];

vi.mock("../../src/notes/graphAdapter", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/notes/graphAdapter")
  >("../../src/notes/graphAdapter");
  // Built from the note-set it is HANDED, not a constant. That is the whole
  // point of this mock: the bug under test is "the pane mounted before the note
  // cache populated, so the model was built from nothing", and a mock that
  // returned the same model for an empty note-set could not express it.
  const buildFrom = (
    notes: ReadonlyArray<{ noteUuid: string; title: string | null }>,
  ): GraphModel => ({
    nodes: notes.map((n) => ({ id: n.noteUuid, title: n.title })),
    edges:
      notes.length > 1
        ? [
            {
              source: notes[0]!.noteUuid,
              target: notes[1]!.noteUuid,
              weight: 1,
            },
          ]
        : [],
  });
  return {
    ...actual,
    loadWholeVaultGraph: async (notes: typeof NOTES) => buildFrom(notes),
    loadSubgraphForNotes: async (_ids: string[], notes: typeof NOTES) =>
      buildFrom(notes),
    loadNeighborhood: async (
      seed: string,
      _depth: 1 | 2,
      _direction: string,
      notes: typeof NOTES,
    ) => buildFrom(notes.filter((n) => n.noteUuid === seed)),
    isolatedModel: () => ({ nodes: [], edges: [] }),
  };
});

vi.mock("../../src/notes/vaultIndices", () => ({
  tagTree: async () => [
    { key: "work", display: "Work", subtreeCount: 2, children: [] },
  ],
  byTag: async (tag: string) => {
    byTagCalls.push(tag);
    return tag === "work" ? ["n-a", "n-b"] : [];
  },
  vaultIndicesOrphans: async () => [],
}));

// Mutable, so a test can drive the one ordering the pane gets wrong: mounting
// BEFORE the note cache has populated. The hook is called on every render, so
// changing this and re-rendering is what the real cache filling in looks like.
let resolverNotes = NOTES;

vi.mock("../../src/notes/resolverNotes", () => ({
  useResolverNotes: () => resolverNotes,
}));

vi.mock("../../src/notes/sidebarState", () => ({
  useSelectedNote: () => ({ selectedId: null }),
}));

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: { color_groups: colorGroups },
  }),
}));

vi.mock("../../src/notes/indexNonce", () => ({
  useIndexNonce: () => 1,
  getIndexNonce: () => 1,
}));

vi.mock("../../src/notes/graphLayoutPersist", () => ({
  loadGraphLayoutFromDisk: async () => {},
  scheduleGraphLayoutFlush: () => {},
}));

// A spy, not a no-op: the Critical this branch was rejected for is "the
// default seeding WROTE to synced user content", so the absence of the write is
// the assertion that matters most in this file.
const setColorGroups = vi.fn(async () => {});

vi.mock("../../src/lib/prefs", () => ({
  setColorGroups: (...args: unknown[]) =>
    (setColorGroups as unknown as (...a: unknown[]) => Promise<void>)(...args),
}));

const graphSettings = {
  showArrows: true,
  labelFadeZoom: 1.4,
  nodeSize: 6,
  nodeSizeStrength: 1.2,
  lineThickness: 1,
  forceCenterStrength: 1,
  forceRepelStrength: 70,
  forceLinkStrength: 1,
  forceLinkDistance: 40,
};

vi.mock("../../src/notes/workspaceContext", () => ({
  useWorkspace: () => ({
    graphSettings,
    setGraphSettings: () => {},
    openNewTabInFocused: () => {},
  }),
}));

// The canvas is the lazy chunk and needs a 2D context jsdom does not have; the
// list mode is the other rendering of the same model and needs no canvas, so
// the pane is asserted in list mode and the canvas is stubbed.
// The canvas records the MODEL PROP it is handed, so a test can assert the
// prop's IDENTITY rather than its content: the real canvas tears itself down and
// re-runs the layout when this prop is a new object, which is the contract
// `gc1` pins.
const canvasModels: unknown[] = [];

vi.mock("../../src/notes/components/GraphCanvas", () => ({
  default: ({ model }: { model: unknown }) => {
    canvasModels.push(model);
    return <canvas data-testid="editor.graph-canvas" />;
  },
}));

const { GraphPane } = await import("../../src/notes/components/GraphView");

const bareTagRule = (): ColorGroup => ({
  id: "r1",
  name: "work",
  color: "group-teal",
  enabled: true,
  filter: { kind: "hasTag", tag: "work" },
});

beforeEach(() => {
  canvasModels.length = 0;
  setColorGroups.mockClear();
  colorGroups = [];
  byTagCalls.length = 0;
  resolverNotes = NOTES;
});

afterEach(cleanup);

/** Wait for the pane to finish its async build. `data-node-count` is written
 *  once the model lands, which is the earliest point the pane can be asserted. */
async function settledPane(): Promise<HTMLElement> {
  const pane = await screen.findByTestId("editor.graph-pane");
  await waitFor(() =>
    expect(pane.getAttribute("data-node-count")).not.toBe("0"),
  );
  return pane;
}

describe("GraphPane mounts (myne-md/myne#727)", () => {
  it("colours a rule-less vault from the DERIVED default, and writes nothing", async () => {
    // The default grouping by tag is derived at render time, not persisted
    // (myne-md/myne#727). Persisting it was a data-loss bug: `color_groups` is
    // shared, whole-value LWW content, and "the list is empty" is the same state
    // before the prefs read resolves, on a failed read, and after a deliberate
    // deletion. The assertion that matters is the SECOND one.
    render(<GraphPane />);
    const pane = await settledPane();
    // The derived grouping arrives with the TAG TREE, which is its own IPC, so
    // the counts are asserted after it rather than after the model.
    await waitFor(() =>
      expect(pane.getAttribute("data-tag-node-count")).toBe("1"),
    );
    // Two notes plus the derived hub for the one qualifying tag.
    expect(pane.getAttribute("data-node-count")).toBe("3");
    expect(pane.getAttribute("data-colored-node-count")).toBe("2");
    expect(setColorGroups).not.toHaveBeenCalled();
  });

  it("adds a tag node for a bare hasTag rule, and paints it from the same map", async () => {
    colorGroups = [bareTagRule()];
    render(<GraphPane />);
    const pane = await settledPane();
    await waitFor(() =>
      expect(pane.getAttribute("data-tag-node-count")).toBe("1"),
    );
    // 2 notes + 1 hub.
    expect(pane.getAttribute("data-node-count")).toBe("3");
    // The hub is painted, but the NOTE count a scenario reads must not move
    // because of it: 2 notes matched by the rule, hub excluded.
    expect(pane.getAttribute("data-colored-node-count")).toBe("2");
  });

  it("does NOT add a tag node for a rule that is not a bare hasTag leaf", async () => {
    // A combinator matches a SUBSET of the tag's notes, so a hub would connect
    // to notes the rule does not match.
    colorGroups = [
      {
        id: "r1",
        name: "work",
        color: "group-teal",
        enabled: true,
        filter: {
          kind: "and",
          children: [
            { kind: "hasTag", tag: "work" },
            { kind: "inFolder", path: "Work/" },
          ],
        },
      },
    ];
    render(<GraphPane />);
    const pane = await settledPane();
    // Let the colour effect settle before reading the hub count.
    await waitFor(() => expect(byTagCalls).toContain("work"));
    expect(pane.getAttribute("data-tag-node-count")).toBe("0");
    expect(pane.getAttribute("data-node-count")).toBe("2");
  });

  it("renders the hub in the LIST as its own row, which filters instead of opening", async () => {
    colorGroups = [bareTagRule()];
    render(<GraphPane />);
    const pane = await settledPane();
    await waitFor(() =>
      expect(pane.getAttribute("data-tag-node-count")).toBe("1"),
    );
    (await screen.findByTestId("editor.graph-view-list")).click();
    const tagRow = await screen.findByTestId("editor.graph-list-tag");
    expect(tagRow.getAttribute("data-tag-key")).toBe("work");
    // The two notes, and only the two notes, are note rows.
    expect(screen.getAllByTestId("editor.graph-list-row")).toHaveLength(2);
  });

  it("builds once the note cache arrives, when the pane mounted before it", async () => {
    // THE reported bug, twice: "the graph opens and never loads", and "it only
    // hangs when the app was frozen and came back". The build effect must not
    // depend on the note cache (SYNC-14: a frozen graph does not re-jumble on a
    // vault change), so a pane that mounts before the cache has populated builds
    // an EMPTY model, and the recovery used to be keyed on the index nonce,
    // which a pane mounted after the index was built never sees change.
    resolverNotes = [];
    const { rerender } = render(<GraphPane />);
    const pane = await screen.findByTestId("editor.graph-pane");
    await waitFor(() =>
      expect(pane.getAttribute("data-node-count")).toBe("0"),
    );
    // The cache fills in. Two notes, plus the derived hub once the tag tree
    // lands, so the assertion waits for the NOTE count's floor rather than for
    // an exact total that depends on a second IPC.
    resolverNotes = NOTES;
    rerender(<GraphPane />);
    await waitFor(() =>
      expect(pane.getAttribute("data-node-count")).not.toBe("0"),
    );
    expect(Number(pane.getAttribute("data-node-count"))).toBeGreaterThanOrEqual(2);
  });

  it("SETTLES on a vault with no notes, instead of rebuilding forever", async () => {
    // The other half of the same state machine. One cold-open attempt is
    // legitimate (an empty model at mount is what the cache filling in late
    // looks like), but a vault that genuinely has no notes must stop there: the
    // re-arm is gated on the note set having GROWN since the last empty build,
    // so an empty view cannot spin.
    resolverNotes = [];
    render(<GraphPane />);
    const pane = await screen.findByTestId("editor.graph-pane");
    await waitFor(() =>
      expect(pane.getAttribute("data-node-count")).toBe("0"),
    );
    await new Promise((r) => setTimeout(r, 60));
    const settled = pane.getAttribute("data-layout-nonce");
    // Give a runaway effect a chance to be a runaway effect.
    await new Promise((r) => setTimeout(r, 120));
    expect(pane.getAttribute("data-layout-nonce")).toBe(settled);
  });

  it("keeps its tag nodes across a filter round trip (All -> tag -> All)", async () => {
    // THE reported bug: "applying a tag filter and returning to All makes the
    // tag nodes look empty". The build effect calls `setModel(null)` at the top
    // of every run, a null model makes the colour effect clear the hubs, and the
    // guard that decided whether to write them back compared against a ref that
    // had survived the clear, so the next run computed the key it had already
    // stored, skipped the write, and the hubs were gone for good.
    colorGroups = [bareTagRule()];
    render(<GraphPane />);
    const pane = await settledPane();
    await waitFor(() =>
      expect(pane.getAttribute("data-tag-node-count")).toBe("1"),
    );

    // Apply the tag filter: the tag view is notes-only BY DESIGN, so no hubs.
    const select = screen.getByTestId("editor.graph-filter");
    fireEvent.change(select, { target: { value: "tag:work" } });
    await waitFor(() =>
      expect(pane.getAttribute("data-tag-node-count")).toBe("0"),
    );

    // …and back to All. The hubs have to come back.
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() =>
      expect(pane.getAttribute("data-tag-node-count")).toBe("1"),
    );
  });

  it("offers All as the filter's first option, and no separate All chip", async () => {
    // "All" and the dropdown's empty option were two controls doing the same
    // thing; the chip is gone and the dropdown opens on All.
    render(<GraphPane />);
    await settledPane();
    const select = screen.getByTestId("editor.graph-filter");
    const options = Array.from(select.querySelectorAll("option")).map((o) =>
      o.getAttribute("value"),
    );
    expect(options[0]).toBe("");
    // `value` is a DOM property on a select, not an attribute.
    expect((select as HTMLSelectElement).value).toBe("");
  });

  it("puts the controls on their own line in LIST mode, so nothing overlaps the rows", async () => {
    // The reported defect: a floating cluster over a scrolling list is a set of
    // buttons sitting on the first rows, and the rows slide under them. The
    // overlay is for the PICTURE; the list is a document and its controls get a
    // line above it (myne-md/myne#727).
    render(<GraphPane />);
    const pane = await settledPane();
    const controls = screen.getByTestId("editor.graph-controls");

    // In the picture the controls float over the canvas.
    expect(controls.style.position).toBe("absolute");
    // The list is reachable only once the pane has a model to render it from.
    await waitFor(() => expect(pane.getAttribute("data-node-count")).not.toBe("0"));

    fireEvent.click(screen.getByTestId("editor.graph-view-list"));
    const list = await screen.findByTestId("editor.graph-list");
    expect(controls.style.position).toBe("relative");
    // and the list is a SIBLING BELOW the row, not underneath it.
    expect(controls.contains(list)).toBe(false);
    const order = Array.from(pane.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(order.indexOf("editor.graph-controls")).toBeLessThan(
      order.indexOf("editor.graph-list"),
    );

    // Back to the picture, and the overlay returns.
    fireEvent.click(screen.getByTestId("editor.graph-view-graph"));
    await waitFor(() => expect(controls.style.position).toBe("absolute"));
  });

  it("hands the canvas the SAME model object across a colour-only rule change", async () => {
    // The repaint-only contract, at the seam that decides it. The real canvas's
    // `[model]` effect re-runs on a new OBJECT, so a colour edit that produces
    // one re-lays-out the graph, which is what `gc1` caught in the container.
    colorGroups = [bareTagRule()];
    const { rerender } = render(<GraphPane />);
    const pane = await settledPane();
    await waitFor(() =>
      expect(pane.getAttribute("data-tag-node-count")).toBe("1"),
    );
    await waitFor(() => expect(canvasModels.length).toBeGreaterThan(0));
    const before = canvasModels.at(-1);

    // The same rule, a different colour: nothing about the MODEL changed.
    colorGroups = [{ ...bareTagRule(), color: "group-rose" }];
    rerender(<GraphPane />);
    await waitFor(() =>
      expect(pane.getAttribute("data-colored-node-count")).toBe("2"),
    );
    await waitFor(() => expect(canvasModels.length).toBeGreaterThan(0));
    expect(Object.is(canvasModels.at(-1), before)).toBe(true);
  });

  it("paints the ACTIVE half of the view switch instead of a measured thumb", async () => {
    // `Segmented`'s thumb is sized from `offsetWidth`, which is 0 in a pane that
    // mounts before its tab is visible; the selected label then takes
    // `--accent-on` with nothing behind it and the active half renders
    // invisible. The cluster paints the accent directly instead, so this asserts
    // a real background on the active half and none on the other.
    render(<GraphPane />);
    await settledPane();
    const graphHalf = screen.getByTestId("editor.graph-view-graph");
    const listHalf = screen.getByTestId("editor.graph-view-list");
    expect(graphHalf.style.background).toContain("var(--accent)");
    expect(graphHalf.style.color).toContain("var(--accent-on)");
    expect(listHalf.style.background).not.toContain("var(--accent)");
    expect(graphHalf.getAttribute("aria-pressed")).toBe("true");
  });

  it("queries only the AUTHORED rule's tag once a rule exists", async () => {
    // With rules authored, the derived default is not consulted at all: the
    // query set is the rules' own tags, which is what keeps a vault with rules
    // from paying for tags it never mentioned.
    colorGroups = [bareTagRule()];
    render(<GraphPane />);
    await settledPane();
    await waitFor(() => expect(byTagCalls).toContain("work"));
    expect(byTagCalls).toEqual(["work"]);
  });

  it("queries the derived default's tags when the vault has no rules", async () => {
    render(<GraphPane />);
    await settledPane();
    await waitFor(() => expect(byTagCalls).toContain("work"));
    expect(byTagCalls).toEqual(["work"]);
  });
});
