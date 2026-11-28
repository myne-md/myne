// @vitest-environment jsdom
//
// The keyboard and screen-reader pass over the agent surface (task 13 of
// myne-md/myne#771).
//
// Everything here is a channel that exists ONLY for a user who cannot see the
// screen, which is exactly the kind of thing that regresses silently: every
// assertion below has a visual counterpart that keeps working after the
// accessible one is gone, so nothing else in the tree would report it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const chatsList = vi.fn();
const chatsRename = vi.fn();
const chatsDelete = vi.fn();
const noteTitles = vi.hoisted(() => new Map<string, string>());
vi.mock("../../src/notes/sidebarState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/notes/sidebarState")>()),
  // The anchor pill reads a note's NAME from the sidebar's cache
  // (myne-md/myne#848). The provider is not mounted here, and mounting the whole
  // sidebar to render a rail would be a different test.
  useSelectedNote: () => ({ cache: noteTitles }),
}));

vi.mock("../../src/lib/chats", () => ({
  // The roster notifier the wrappers fire (myne-md/myne#771). Mocked to a
  // no-op unsubscribe: what these files drive is the list, not the signal, and
  // a module mock that omits an export makes the importer throw at load.
  subscribeConversationRoster: () => () => {},
  chatsList: (...a: unknown[]) => chatsList(...a),
  chatsRename: (...a: unknown[]) => chatsRename(...a),
  chatsDelete: (...a: unknown[]) => chatsDelete(...a),
}));
vi.mock("../../src/notes/ai/chatPersist", () => ({
  openConversation: vi.fn(async () => {}),
  clearChatPersistForLock: vi.fn(),
}));
vi.mock("../../src/notes/ai/chatStore", () => ({
  getActiveConversationId: () => "c1",
  discardChat: vi.fn(),
}));
vi.mock("../../src/lib/useDateTimeDisplay", () => ({
  useDateTimeDisplay: () => ({ locale: "en", timeZone: "UTC" }),
}));

const { AgentHubList } = await import("../../src/notes/agent/AgentHubList");

const ROWS = [
  { id: "c1", title: "Anchored run", updated_at: 1_700_000_000, created_at: 1, version: 1, note_id: "n1" },
  { id: "c2", title: "Vault-wide run", updated_at: 1_699_000_000, created_at: 1, version: 1 },
];

beforeEach(() => {
  chatsList.mockReset().mockResolvedValue(ROWS);
  chatsRename.mockReset().mockResolvedValue(undefined);
  chatsDelete.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

async function renderHub() {
  render(<AgentHubList onOpenFocus={() => {}} onOpenNote={() => {}} />);
  await waitFor(() => expect(screen.getAllByTestId("agent.hub-row").length).toBe(2));
}

describe("the open conversation says so to a reader, not only to the eye", () => {
  it("marks the active row with aria-current", async () => {
    // `data-active` paints it and carries nothing. They were one attribute
    // doing one of the two jobs, and the one it was doing was the visible one.
    await renderHub();
    // Found by testid: the card sits inside its tooltip's wrapper now, so the
    // row's first child is that wrapper rather than the card (myne-md/myne#848).
    const cards = screen.getAllByTestId("agent.hub-card");
    const active = cards[0]!;
    const inactive = cards[1]!;
    expect(active.getAttribute("data-active")).toBe("true");
    expect(active.getAttribute("aria-current")).toBe("true");
    expect(inactive.getAttribute("aria-current")).toBeNull();
  });
});

describe("a change the user did not navigate to is announced", () => {
  // Rename and delete both change the list WITHOUT moving focus, so a
  // screen-reader user pressed a button and heard nothing: the row they were
  // on either changed name underneath them or stopped existing.

  it("mounts the live region before there is anything to say", async () => {
    // A region that appears at the same moment its text does is a region most
    // readers never announce — they were not observing an element that did not
    // exist. This is the single most common way a live region ships broken.
    await renderHub();
    const announcer = screen.getByTestId("agent.hub-announcer");
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.textContent).toBe("");
  });

  it("announces a rename", async () => {
    await renderHub();
    fireEvent.click(screen.getAllByTestId("agent.hub-menu")[0]!);
    fireEvent.click(screen.getByTestId("agent.hub-rename"));
    const input = screen.getByTestId("agent.hub-rename-input");
    fireEvent.change(input, { target: { value: "New name" } });
    // The field is the whole control: Enter saves, there is no confirm button.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() =>
      expect(screen.getByTestId("agent.hub-announcer").textContent).toContain("New name"),
    );
  });

  it("announces a delete", async () => {
    await renderHub();
    fireEvent.click(screen.getAllByTestId("agent.hub-menu")[0]!);
    fireEvent.click(screen.getByTestId("agent.hub-delete"));
    const confirm = await screen.findByTestId("agent.hub-delete-confirm");
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("agent.hub-announcer").textContent?.length ?? 0,
      ).toBeGreaterThan(0),
    );
  });
});
