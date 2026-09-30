// @vitest-environment jsdom
//
// `<NewTabChooser>` as a start page (myne-md/myne#772): the places row, the
// mixed notes-and-commands recency list, and the one search over both.
//
// Seams mocked: the sidebar note cache (a plain Map stands in for it, with
// `liveCache` as a pass-through since its predicate is tested with the
// sidebar), `usePrefs`, and i18n (keys render as themselves). The command
// registry and the `ribbonCommands` bridge are REAL: the bridge's handlers are
// what the Editor registers, so the test installs them the same way.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

type Rec = { noteUuid: string; title: string | null; updatedAt: Date | null };
let cache = new Map<string, Rec>();

vi.mock("../../src/notes/sidebarState", () => ({
  useSelectedNote: () => ({ cache }),
  liveCache: (c: Map<string, Rec>) => c,
}));
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { archived_folders: [] } }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { NewTabChooser, NEW_TAB_PLACES } from "../../src/notes/components/NewTabChooser";
import { ribbonCommands } from "../../src/notes/ribbonCommands";
import {
  COMMAND_RECENCY_LIMIT,
  recentCommandRuns,
  recordCommandRun,
  resetCommandRecency,
} from "../../src/lib/commandRecency";
import { dispatchKeybind } from "../../src/commands/keybindEngine";

const NOW = Date.now();
const minutesAgo = (m: number) => NOW - m * 60_000;

let hidden = new Set<string>();
const run = vi.fn();

function mount(overrides: Partial<Parameters<typeof NewTabChooser>[0]> = {}) {
  const props = {
    onPick: vi.fn(),
    onCreate: vi.fn(),
    onCreateDrawing: vi.fn(),
    cancellable: false,
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<NewTabChooser {...props} />);
  return props;
}

beforeEach(() => {
  cache = new Map([
    ["n1", { noteUuid: "n1", title: "Deep Learning", updatedAt: new Date(minutesAgo(60)) }],
    ["n2", { noteUuid: "n2", title: "Graph theory", updatedAt: new Date(minutesAgo(5)) }],
  ]);
  hidden = new Set(["ai.open-agent-vault"]);
  run.mockReset();
  ribbonCommands.run = run;
  ribbonCommands.visibility = (id) => (hidden.has(id) ? "hidden" : "show");
  resetCommandRecency();
});

afterEach(() => {
  cleanup();
  ribbonCommands.run = undefined;
  ribbonCommands.visibility = undefined;
});

describe("NewTabChooser places row", () => {
  it("renders one tile per visible place and runs its command on click", () => {
    mount();
    for (const p of NEW_TAB_PLACES) {
      const tile = screen.queryByTestId(`notes.newTab.place.${p.id}`);
      if (hidden.has(p.id)) expect(tile).toBeNull();
      else expect(tile).not.toBeNull();
    }
    fireEvent.click(screen.getByTestId("notes.newTab.place.attachments.open"));
    expect(run).toHaveBeenCalledWith("attachments.open");
  });

  it("gives way to results while searching", () => {
    mount();
    fireEvent.change(screen.getByTestId("notes.newTab.search"), { target: { value: "deep" } });
    expect(screen.queryByTestId("notes.newTab.place.graph.show")).toBeNull();
  });
});

describe("NewTabChooser recent list", () => {
  it("mixes notes and commands by recency, newest first", () => {
    recordCommandRun("notes.random", minutesAgo(20));
    mount();
    const rows = screen
      .getAllByRole("button")
      .filter((b) => /note-row|command-row/.test(b.dataset.testid ?? ""));
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      "notes.newTab.note-row", // Graph theory, 5 min
      "notes.newTab.command-row", // random note, 20 min
      "notes.newTab.note-row", // Deep Learning, 60 min
    ]);
    fireEvent.click(rows[1]!);
    expect(run).toHaveBeenCalledWith("notes.random");
  });

  it("leaves out commands that already have a tile, and hidden ones", () => {
    recordCommandRun("graph.show", minutesAgo(1));
    recordCommandRun("ai.open-agent-vault", minutesAgo(2));
    mount();
    expect(screen.queryByTestId("notes.newTab.command-row")).toBeNull();
  });
});

describe("NewTabChooser search", () => {
  it("finds commands as well as notes, prefix matches first", () => {
    mount();
    fireEvent.change(screen.getByTestId("notes.newTab.search"), { target: { value: "graph" } });
    const first = screen
      .getAllByRole("button")
      .find((b) => /note-row|command-row/.test(b.dataset.testid ?? ""))!;
    // "Graph theory" starts with the query; so does no command label, which
    // start with a verb ("Show graph"), so the note leads.
    expect(within(first).getByText("Graph theory")).toBeTruthy();
    expect(screen.getAllByTestId("notes.newTab.command-row").length).toBeGreaterThan(0);
  });

  it("Enter opens the top row, a note or a command", () => {
    const props = mount();
    const input = screen.getByTestId("notes.newTab.search");
    fireEvent.change(input, { target: { value: "deep" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onPick).toHaveBeenCalledWith("n1");

    fireEvent.change(input, { target: { value: "show graph" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledWith("graph.show");
  });
});

describe("command recency", () => {
  it("moves a re-run command to the front instead of listing it twice", () => {
    recordCommandRun("a", 1);
    recordCommandRun("b", 2);
    recordCommandRun("a", 3);
    expect(recentCommandRuns()).toEqual([
      { id: "a", at: 3 },
      { id: "b", at: 2 },
    ]);
  });

  it("keeps at most the limit", () => {
    for (let i = 0; i < COMMAND_RECENCY_LIMIT + 5; i++) recordCommandRun(`c${i}`, i);
    expect(recentCommandRuns()).toHaveLength(COMMAND_RECENCY_LIMIT);
    expect(recentCommandRuns()[0]!.id).toBe(`c${COMMAND_RECENCY_LIMIT + 4}`);
  });

  it("counts a command run by its key chord", () => {
    const fired = vi.fn();
    const handled = dispatchKeybind(
      { key: "g", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
      "bubble",
      { stageName: "editor", hasSelectedNote: false, activeModal: null, focusKind: "other" },
      [{ id: "graph.show", scope: { stage: "editor" }, run: fired }],
      { "graph.show": ["Mod-Shift-g"] },
      true,
    );
    expect(handled).toBe(true);
    expect(fired).toHaveBeenCalled();
    expect(recentCommandRuns()[0]?.id).toBe("graph.show");
  });
});
