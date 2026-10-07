// The conversation roster's change signal (myne-md/myne#771).
//
// The agent hub's rail loaded its roster once, on mount, and nothing said a
// word afterwards — so a conversation created by SENDING a message did not
// appear in the list beside the reply that created it. The user watched an
// answer arrive into a history claiming there was nothing there, and it came
// back on the next mount, which made it look like a refresh quirk rather than
// a missing wire.
//
// The notifier lives in the WRAPPERS rather than beside each call site, the
// shape `writePref` has for the prefs nonce: a future write site cannot forget
// to announce, because the announcement is in the path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../../src/platform/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { chatsCreate, chatsDelete, chatsRename, chatsAppendTurn, chatsList, subscribeConversationRoster } =
  await import("../../src/lib/chats");

beforeEach(() => {
  invoke.mockReset().mockResolvedValue("id");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("every catalog mutation announces itself", () => {
  it("create does", async () => {
    const seen = vi.fn();
    const off = subscribeConversationRoster(seen);
    await chatsCreate("{}");
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it("rename does", async () => {
    const seen = vi.fn();
    const off = subscribeConversationRoster(seen);
    await chatsRename("c1", "New");
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it("delete does", async () => {
    const seen = vi.fn();
    const off = subscribeConversationRoster(seen);
    await chatsDelete("c1");
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("what deliberately does not", () => {
  it("a READ is not a change", async () => {
    // Announcing on a list would make every listener's own refresh re-enter
    // the notifier — a loop whose only bound is how fast the host answers.
    const seen = vi.fn();
    const off = subscribeConversationRoster(seen);
    invoke.mockResolvedValue([]);
    await chatsList();
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it("appending a turn is not a roster change", async () => {
    // It writes the CONVERSATION, not the catalog row. A listener re-reads the
    // roster, so announcing here would be a full re-list per streamed reply.
    const seen = vi.fn();
    const off = subscribeConversationRoster(seen);
    await chatsAppendTurn("c1", "{}");
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it("a REFUSED mutation announces nothing", async () => {
    // The bump is after the await on purpose. A listener re-reading on a
    // refusal would replace a correct list with the same list, and on a create
    // would briefly show a row the host rejected.
    const seen = vi.fn();
    const off = subscribeConversationRoster(seen);
    invoke.mockRejectedValue({ kind: "CatalogUnreadable" });
    await expect(chatsCreate("{}")).rejects.toBeDefined();
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});

describe("unsubscribing works", () => {
  it("stops delivering", async () => {
    // A rail that unmounts and keeps its listener is a `setState` after
    // unmount on every later write, for the life of the session.
    const seen = vi.fn();
    subscribeConversationRoster(seen)();
    await chatsCreate("{}");
    expect(seen).not.toHaveBeenCalled();
  });
});
