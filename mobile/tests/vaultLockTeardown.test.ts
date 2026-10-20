// Mobile's lock teardown, behaviourally (myne-md/myne#849 task 12).
//
// `scripts/check-frontend-lock-teardown.mjs` is the machine half of this rule and it
// reads CALL SHAPES: it asserts that `lockVault` contains a `clearAwareness()` call,
// which is exactly what a rename or a deletion would break. What it cannot see is
// ORDER, and order is the whole property here: the live-presence store holds OTHER
// PEOPLE's names, carets and selections, so a store dropped after a flush that can
// reject is a store that a failed write can leave resident in a locked vault's RAM.
// That is the arm this file exists for.
//
// The sibling modules are mocked because they are IPC and caches with no part in the
// claim; the awareness store is the REAL module, so what is asserted is the shared
// store's own state rather than a spy on a copy.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAwareness, getAwarenessSnapshot, setAwareness } from "@myne/awareness-store";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  clearCustomTheme: vi.fn(),
  flushGraphLayoutNow: vi.fn(async () => undefined),
  resetGraphLayoutOnLock: vi.fn(),
  flushWorkspaceNow: vi.fn(async () => undefined),
  resetWorkspaceOnLock: vi.fn(),
  endAgentRun: vi.fn(),
  clearChatHistoryPersistForLock: vi.fn(),
  resetDecodedAspects: vi.fn(),
  resetPreviewCache: vi.fn(),
  resetTranscripts: vi.fn(),
  resetMermaidZoom: vi.fn(),
  resetDateTimeDisplayForLock: vi.fn(),
}));

vi.mock("../src/platform/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/lib/customTheme", () => ({ clearCustomTheme: mocks.clearCustomTheme }));
vi.mock("../src/lib/graph-layout-persist", () => ({
  flushGraphLayoutNow: mocks.flushGraphLayoutNow,
  resetGraphLayoutOnLock: mocks.resetGraphLayoutOnLock,
}));
vi.mock("../src/lib/workspace-persist", () => ({
  flushWorkspaceNow: mocks.flushWorkspaceNow,
  resetWorkspaceOnLock: mocks.resetWorkspaceOnLock,
}));
vi.mock("../src/lib/agent-lifetime", () => ({ endAgentRun: mocks.endAgentRun }));
vi.mock("../src/lib/chatHistory", () => ({ clearChatHistoryPersistForLock: mocks.clearChatHistoryPersistForLock }));
vi.mock("@myne/editor/attachments/decoded-aspect", () => ({ resetDecodedAspects: mocks.resetDecodedAspects }));
vi.mock("@myne/editor/attachments/session-caches", () => ({
  resetPreviewCache: mocks.resetPreviewCache,
  resetTranscripts: mocks.resetTranscripts,
  resetMermaidZoom: mocks.resetMermaidZoom,
}));
vi.mock("@myne/editor/host/lib/datetimeFormat", () => ({ resetDateTimeDisplayForLock: mocks.resetDateTimeDisplayForLock }));

import { lockVault } from "../src/lib/vault-unlock";

/** One peer in the shared store, as a routed frame leaves it. */
function seedPeer(noteId: string, actorId: string, caret: number) {
  setAwareness({
    peersByNote: new Map([
      [noteId, new Map([[actorId, { id: actorId, noteId, label: null, unAttributed: true, caret, selection: null, color: 1 }]])],
    ]),
    droppedAt: null,
  });
}

/** The peer count across every note. */
function peerCount(): number {
  return [...getAwarenessSnapshot().peersByNote.values()].reduce((n, m) => n + m.size, 0);
}

beforeEach(() => {
  clearAwareness();
  for (const fn of Object.values(mocks)) fn.mockClear();
  mocks.flushGraphLayoutNow.mockResolvedValue(undefined);
  mocks.invoke.mockResolvedValue(undefined);
});

describe("locking the vault drops the presence peers", () => {
  it("drops them, and the fixture is not vacuous", async () => {
    seedPeer("note-a", "actor-1", 4);
    // Non-vacuity: a store that was already empty would make every assertion below
    // pass while the clear was deleted.
    expect(peerCount()).toBe(1);

    await lockVault();
    expect(peerCount()).toBe(0);
  });

  it("drops them even when an earlier flush REJECTS, which is what pins the order", async () => {
    seedPeer("note-a", "actor-1", 4);
    mocks.flushGraphLayoutNow.mockRejectedValueOnce(new Error("no vault"));
    await expect(lockVault()).rejects.toThrow("no vault");
    // The point of the arm: the clear sits BEFORE the first await, so a failed
    // write cannot leave other people's names resident in a locked vault.
    expect(peerCount()).toBe(0);
  });

  it("still drops them when the lock command itself rejects", async () => {
    seedPeer("note-a", "actor-1", 4);
    mocks.invoke.mockRejectedValueOnce(new Error("slot gone"));
    await expect(lockVault()).rejects.toThrow("slot gone");
    expect(peerCount()).toBe(0);
  });
});
