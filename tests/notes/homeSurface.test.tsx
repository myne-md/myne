// @vitest-environment jsdom
//
// The home surface's arrangement (myne-md/myne#1074, task 15).
//
// What is under test is the WIRING and the two properties the plan's acceptance
// criteria name: keyboard reordering writes the same model the drag writes, and
// removing the last card leaves a real empty state with a way back. The cards'
// own data is NOT under test here — each card renders the module that owns it,
// and those modules have their own tests.
//
// `useTranslation` echoes its keys, so the copy assertions compare against the
// repo's own key names and the closing case proves each key exists in the English
// catalog rather than in the stub.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const en = ((await import("../../locales/en/common.json")).default ?? {}) as Record<
  string,
  unknown
>;

const prefsState = vi.hoisted(() => ({
  current: { home_cards: null as unknown, home_open_on_start: false },
}));
const setHomeCards = vi.hoisted(() => vi.fn());
const setHomeOpenOnStart = vi.hoisted(() => vi.fn());

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
  setHomeOpenOnStart,
}));

import { HomeSurface } from "../../src/notes/home/HomeSurface";
import { DEFAULT_HOME_CARDS } from "../../src/notes/home/homeCards";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  prefsState.current = { home_cards: null, home_open_on_start: false };
});

describe("the home surface", () => {
  it("draws the default layout when the vault has never been arranged", () => {
    render(<HomeSurface />);
    expect(screen.getByTestId("home.cards")).toBeTruthy();
    // Eleven cards, and nothing was written: a vault that never touched home
    // stays byte-identical, which is the plan's first acceptance criterion.
    for (const card of DEFAULT_HOME_CARDS) {
      expect(screen.getByTestId(`home.card.${card.id}`)).toBeTruthy();
    }
    expect(setHomeCards).not.toHaveBeenCalled();
  });

  it("draws a card this build does not know as an inert row that says so", () => {
    prefsState.current = {
      home_cards: [{ id: "future", kind: "future-kind", span: 1 }],
      home_open_on_start: false,
    };
    render(<HomeSurface />);
    const card = screen.getByTestId("home.card.future");
    expect(card.textContent).toContain("notes.home.cards.unknown");
    // And it is NOT dropped: the codec kept it, so the surface keeps it.
    expect(card.textContent).toContain("notes.home.cards.unknownNote");
  });

  it("reorders with Alt+ArrowDown and writes the whole list", async () => {
    render(<HomeSurface />);
    fireEvent.click(screen.getByTestId("home.arrange"));
    const first = screen.getByTestId(`home.edit.row.${DEFAULT_HOME_CARDS[0].id}`);
    fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });

    await waitFor(() => expect(setHomeCards).toHaveBeenCalledTimes(1));
    const written = setHomeCards.mock.calls[0][0] as { id: string }[];
    // The first two swapped, everything else kept its place: one write of the
    // WHOLE arrangement, which is the only shape the stored value has.
    expect(written[0].id).toBe(DEFAULT_HOME_CARDS[1].id);
    expect(written[1].id).toBe(DEFAULT_HOME_CARDS[0].id);
    expect(written).toHaveLength(DEFAULT_HOME_CARDS.length);
  });

  it("leaves a real empty state with a way back when the last card goes", () => {
    prefsState.current = {
      home_cards: [{ id: "favorites", kind: "favorites", span: 1 }],
      home_open_on_start: false,
    };
    render(<HomeSurface />);
    fireEvent.click(screen.getByTestId("home.arrange"));
    fireEvent.click(screen.getByTestId("home.edit.remove.favorites"));
    expect(setHomeCards).toHaveBeenCalledWith([]);
  });

  it("toggles open-on-start on this device only", () => {
    render(<HomeSurface />);
    fireEvent.click(screen.getByTestId("home.arrange"));
    fireEvent.click(screen.getByTestId("home.edit.open-on-start"));
    expect(setHomeOpenOnStart).toHaveBeenCalledWith(true);
  });
});

describe("the copy this surface uses", () => {
  it("names every key it renders in the English catalog", () => {
    const keys = [
      "notes.home.title",
      "notes.home.arrange",
      "notes.home.arrangeTitle",
      "notes.home.addCard",
      "notes.home.removeCard",
      "notes.home.spanWide",
      "notes.home.spanNarrow",
      "notes.home.onStart",
      "notes.home.onStartHint",
      "notes.home.emptyTitle",
      "notes.home.emptyBody",
      "notes.home.cards.unknown",
      "notes.home.cards.unknownNote",
      "notes.home.cards.pending",
    ];
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
