// @vitest-environment jsdom
//
// The home surface's board and its in-place editing (myne-md/myne#1074).
//
// What is under test is the WIRING and the properties that make the board
// trustworthy: the stored arrangement is drawn as given, a kind this build does
// not know is kept rather than dropped, every edit writes the WHOLE list, the
// keyboard produces the same writes as the pointer, and the AI gate removes a card
// without touching the stored row.
//
// The widgets' own data is NOT under test: each one renders the module that owns
// it, and those modules have their own tests.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const en = ((await import("../../locales/en/common.json")).default ?? {}) as Record<
  string,
  unknown
>;

interface PrefsStub {
  home_cards: { id: string; kind: string; span: number; options?: Record<string, string> }[] | null;
  home_open_on_start: boolean;
  favorites: string[];
  saved_views: unknown[];
  ai_enabled: boolean;
}

const prefsState = vi.hoisted(() => ({
  current: {
    home_cards: null as unknown,
    home_open_on_start: false,
    favorites: [] as string[],
    saved_views: [] as unknown[],
    ai_enabled: false,
  },
}));
const setHomeCards = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-i18next")>();
  return {
    ...real,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: prefsState.current, loaded: true }),
}));
vi.mock("../../src/lib/prefs", () => ({
  setHomeCards,
  setHomeOpenOnStart: vi.fn(),
}));

// The widgets read the modules that own their data; the board's own contract is
// what this suite is about.
vi.mock("../../src/notes/workspaceContext", () => ({
  useWorkspace: () => ({
    openInFocused: vi.fn(),
    openTasks: vi.fn(),
    openCalendar: vi.fn(),
    openAttachments: vi.fn(),
    openGraph: vi.fn(),
    openAgent: vi.fn(),
    openView: vi.fn(),
    openTemplates: vi.fn(),
  }),
}));
vi.mock("../../src/notes/sidebarState", () => ({
  useSelectedNoteOptional: () => null,
}));
vi.mock("../../src/notes/taskIndex", () => ({
  useLiveVaultTasks: () => [],
}));
vi.mock("../../src/hooks/useLiveCalendarEvents", () => ({
  useLiveCalendarEvents: () => [],
}));
vi.mock("../../src/hooks/useSyncStatus", () => ({
  useSyncStatus: () => ({ status: { state: "disabled" }, syncNow: vi.fn(), busy: false }),
}));
vi.mock("../../src/lib/attachments", () => ({
  catalogList: () => Promise.resolve([]),
  attachmentUnusedList: () => Promise.resolve([]),
}));
vi.mock("../../src/lib/chats", () => ({
  chatsList: () => Promise.resolve([]),
}));
vi.mock("../../src/notes/createNote", () => ({
  createNote: () => Promise.resolve("new-id"),
}));

import { HomeSurface } from "../../src/notes/home/HomeSurface";
import { DEFAULT_HOME_CARDS, HOME_CARD_SPECS } from "../../src/notes/home/homeCards";
import { HOME_CARD_DEFS } from "../../src/notes/home/cardBodies";

const EMPTY_PREFS: PrefsStub = {
  home_cards: null,
  home_open_on_start: false,
  favorites: [],
  saved_views: [],
  ai_enabled: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  prefsState.current = { ...EMPTY_PREFS };
});

describe("the board", () => {
  it("draws the default layout when the vault has never been arranged", () => {
    render(<HomeSurface />);
    expect(screen.getByTestId("home.cards")).toBeTruthy();
    // Every default card is on the board, and nothing was written: a vault that
    // never touched home stays byte-identical.
    for (const card of DEFAULT_HOME_CARDS) {
      expect(screen.getByTestId(`home.card.${card.id}`)).toBeTruthy();
    }
    expect(setHomeCards).not.toHaveBeenCalled();
  });

  it("has no page title and no arrange mode", () => {
    render(<HomeSurface />);
    // The heading was a label on a label: the tab already says where you are.
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByTestId("home.arrange")).toBeNull();
  });

  it("keeps a kind this build does not know and says so", () => {
    prefsState.current = {
      ...EMPTY_PREFS,
      home_cards: [{ id: "future", kind: "future-kind", span: 1 }],
    };
    render(<HomeSurface />);
    const card = screen.getByTestId("home.card.future");
    expect(card.textContent).toContain("notes.home.cards.unknown");
    expect(card.textContent).toContain("notes.home.cards.pending");
  });

  it("keeps a real empty state when the board has no cards, with a way back", () => {
    prefsState.current = { ...EMPTY_PREFS, home_cards: [] };
    render(<HomeSurface />);
    expect(screen.getByTestId("home.empty.add")).toBeTruthy();
  });

  it("hides a widget that needs the AI opt-in without touching the stored row", () => {
    prefsState.current = {
      ...EMPTY_PREFS,
      ai_enabled: false,
      home_cards: [
        { id: "agent-prompt", kind: "agent-prompt", span: 2 },
        { id: "favorites", kind: "favorites", span: 1 },
      ],
    };
    render(<HomeSurface />);
    // Filtered out of the DRAW, not out of the stored list: turning the opt-in
    // back on brings the card back.
    expect(screen.queryByTestId("home.card.agent-prompt")).toBeNull();
    expect(screen.getByTestId("home.card.favorites")).toBeTruthy();
    expect(setHomeCards).not.toHaveBeenCalled();
  });
});

describe("in-place editing", () => {
  it("moves a card with the arrow keys and writes the whole list", async () => {
    render(<HomeSurface />);
    const first = DEFAULT_HOME_CARDS[0];
    fireEvent.keyDown(screen.getByTestId(`home.card.handle.${first.id}`), { key: "ArrowRight" });
    await waitFor(() => expect(setHomeCards).toHaveBeenCalledTimes(1));
    const written = setHomeCards.mock.calls[0][0] as { id: string }[];
    expect(written[0].id).toBe(DEFAULT_HOME_CARDS[1].id);
    expect(written[1].id).toBe(first.id);
    expect(written).toHaveLength(DEFAULT_HOME_CARDS.length);
  });

  it("widens a card from the menu", async () => {
    prefsState.current = {
      ...EMPTY_PREFS,
      home_cards: [{ id: "favorites", kind: "favorites", span: 1 }],
    };
    render(<HomeSurface />);
    fireEvent.click(screen.getByTestId("home.card.menu.favorites"));
    fireEvent.click(screen.getByTestId("home.card.menu.favorites.wider"));
    await waitFor(() => expect(setHomeCards).toHaveBeenCalledTimes(1));
    expect((setHomeCards.mock.calls[0][0] as { span: number }[])[0].span).toBe(2);
  });

  it("removes a card from the menu, leaving a real empty state", async () => {
    prefsState.current = {
      ...EMPTY_PREFS,
      home_cards: [{ id: "favorites", kind: "favorites", span: 1 }],
    };
    render(<HomeSurface />);
    fireEvent.click(screen.getByTestId("home.card.menu.favorites"));
    fireEvent.click(screen.getByTestId("home.card.menu.favorites.remove"));
    // The write is the assertion: the mock store does not re-render, and the
    // empty board itself is covered by its own case above.
    await waitFor(() => expect(setHomeCards).toHaveBeenCalledWith([]));
  });

  it("adds a widget from the picker", async () => {
    prefsState.current = { ...EMPTY_PREFS, home_cards: [] };
    render(<HomeSurface />);
    fireEvent.click(screen.getByTestId("home.empty.add"));
    fireEvent.click(screen.getByTestId("home.picker.add.storage"));
    await waitFor(() => expect(setHomeCards).toHaveBeenCalledTimes(1));
    const written = setHomeCards.mock.calls[0][0] as { kind: string; id: string }[];
    expect(written).toHaveLength(1);
    expect(written[0]?.kind).toBe("storage");
  });

  it("offers no AI widget in the picker while the opt-in is off", () => {
    prefsState.current = { ...EMPTY_PREFS, home_cards: [] };
    render(<HomeSurface />);
    fireEvent.click(screen.getByTestId("home.empty.add"));
    expect(screen.queryByTestId("home.picker.add.agent-prompt")).toBeNull();
  });
});

describe("the registry and the renderers agree", () => {
  it("gives every declared kind a renderer", () => {
    for (const spec of HOME_CARD_SPECS) {
      expect(HOME_CARD_DEFS[spec.kind], `${spec.kind} has no renderer`).toBeDefined();
    }
  });

  it("names every key it renders in the English catalog", () => {
    const keys = [
      "notes.home.addCard",
      "notes.home.emptyTitle",
      "notes.home.cards.unknown",
      "notes.home.cards.unknownNote",
      "notes.home.cards.pending",
      "notes.home.cardMenu.label",
      "notes.home.cardMenu.wider",
      "notes.home.cardMenu.narrower",
      "notes.home.cardMenu.remove",
      "notes.home.a11y.moveHandle",
      "notes.home.a11y.resizeHandle",
      "notes.home.a11y.moved",
      "notes.home.a11y.resized",
      "notes.home.a11y.removed",
    ];
    for (const spec of HOME_CARD_SPECS) {
      keys.push(spec.labelKey, spec.descriptionKey);
    }
    for (const key of keys) {
      const value = key.split(".").reduce<unknown>((acc, part) => {
        if (acc && typeof acc === "object" && part in acc) {
          return (acc as Record<string, unknown>)[part];
        }
        return undefined;
      }, en);
      expect(typeof value, `${key} is missing from locales/en/common.json`).toBe("string");
    }
  });
});
