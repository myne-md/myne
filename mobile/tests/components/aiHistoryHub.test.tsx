// @vitest-environment jsdom
//
// The phone's agent hub (myne-md/myne#771 task 14).
//
// Mobile does not get a tab system, and nothing here becomes one: the hub is
// the conversation sheet the phone already had, grown the three things that
// made the desktop hub a hub — a mode, a filter, and an anchor a reader can
// see. What this pins is that the three actually narrow the list, because each
// of them is a `.filter()` whose failure mode is showing everything, which
// looks exactly like a list that happens to be short.

import i18n from "@myne/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const chatsList = vi.fn();
vi.mock("../../src/lib/chats", () => ({
  chatsList: (...a: unknown[]) => chatsList(...a),
  chatsRename: vi.fn(async () => {}),
  chatsDelete: vi.fn(async () => {}),
}));
// The real i18n, like `AiHistorySheet.test.tsx` beside it: mocking
// `react-i18next` here fails on `initReactI18next`, which `@myne/i18n` needs at
// import time, and every assertion below is on conversation TITLES or on
// testids rather than on copy — so the real catalog costs nothing.
const { AiHistorySheet } = await import("../../src/app/flows/AiHistorySheet");

const ROWS = [
  { id: "c1", title: "Anchored to a note", updated_at: 3, created_at: 1, version: 1, note_id: "n1" },
  { id: "c2", title: "About the whole vault", updated_at: 2, created_at: 1, version: 1 },
  { id: "c3", title: "Another anchored one", updated_at: 1, created_at: 1, version: 1, note_id: "n2" },
];

beforeEach(async () => {
  await i18n;
  chatsList.mockReset().mockResolvedValue(ROWS);
});
afterEach(cleanup);

async function renderHub() {
  render(
    <AiHistorySheet
      activeId={null}
      onOpen={() => {}}
      onNew={() => {}}
      onDeleted={() => {}}
      onClose={() => {}}
    />,
  );
  await waitFor(() => expect(screen.getAllByTestId("ai.conversation-row").length).toBe(3));
}

const titles = () =>
  screen.queryAllByTestId("ai.conversation-open").map((b) => b.textContent);

describe("the mode says what the list is about", () => {
  it("shows every conversation by default", async () => {
    // `vault` is the resting mode because the sheet is reachable with no note
    // open at all, and a mode that hides everything on arrival is a list that
    // looks broken.
    await renderHub();
    expect(titles()).toHaveLength(3);
    expect(
      screen.getByTestId("ai.history-mode-vault").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("narrows to the anchored ones", async () => {
    await renderHub();
    fireEvent.click(screen.getByTestId("ai.history-mode-note"));
    expect(titles()).toEqual(["Anchored to a note", "Another anchored one"]);
  });

  it("says which mode is on, in a way a reader can hear", async () => {
    // `aria-pressed`, not a background colour. Two buttons that differ only in
    // fill are two buttons a screen reader reads identically.
    await renderHub();
    fireEvent.click(screen.getByTestId("ai.history-mode-note"));
    expect(screen.getByTestId("ai.history-mode-note").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("ai.history-mode-vault").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("the filter narrows by title, and composes with the mode", () => {
  it("filters case-insensitively", async () => {
    await renderHub();
    fireEvent.change(screen.getByTestId("ai.history-search"), {
      target: { value: "WHOLE" },
    });
    expect(titles()).toEqual(["About the whole vault"]);
  });

  it("applies the mode AND the query together", async () => {
    // Two filters that do not compose is the defect worth pinning: each works
    // alone, so a test of either passes while the pair shows the wrong list.
    await renderHub();
    fireEvent.click(screen.getByTestId("ai.history-mode-note"));
    fireEvent.change(screen.getByTestId("ai.history-search"), {
      target: { value: "another" },
    });
    expect(titles()).toEqual(["Another anchored one"]);
  });

  it("distinguishes filtered-to-nothing from an empty vault", async () => {
    // Two different situations that rendered as one sentence everywhere in this
    // app before the epic: "there is nothing here" and "you have hidden
    // everything" need different words and different ways out.
    await renderHub();
    fireEvent.change(screen.getByTestId("ai.history-search"), {
      target: { value: "zzzz-no-such-title" },
    });
    expect(screen.queryByTestId("ai.history-no-match")).not.toBeNull();
    expect(
      screen.queryByTestId("ai.history-empty"),
      "a filtered list must not claim the vault is empty",
    ).toBeNull();
  });

  it("shows the empty state when the vault really has none", async () => {
    chatsList.mockResolvedValue([]);
    render(
      <AiHistorySheet
        activeId={null}
        onOpen={() => {}}
        onNew={() => {}}
        onDeleted={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId("ai.history-empty")).not.toBeNull());
    expect(screen.queryByTestId("ai.history-no-match")).toBeNull();
    // And no controls to narrow a list that has nothing in it.
    expect(screen.queryByTestId("ai.history-search")).toBeNull();
    expect(screen.queryByTestId("ai.history-mode")).toBeNull();
  });
});

describe("the anchor is visible, not merely stored", () => {
  it("chips the anchored rows only", async () => {
    await renderHub();
    const chips = screen.getAllByTestId("ai.conversation-anchor");
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.getAttribute("data-note-id"))).toEqual(["n1", "n2"]);
  });
});
