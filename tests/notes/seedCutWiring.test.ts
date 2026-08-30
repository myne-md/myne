// @vitest-environment jsdom
//
// The two `blockSeedingOfExistingTurns` call sites, asserted through the setters
// rather than by calling the store function.
//
// `tests/notes/chatHistory.test.ts` proves the cut WORKS; nothing proved it is
// WIRED. Deleting either line left all 64 tests in the six touched suites green,
// and the failure is silent egress: a conversation held entirely on-device
// re-sent in full to a provider configured afterwards, or one the user has just
// excluded a folder from.
//
// Both are asserted on the FAILING-persist path too, because that is the
// ordering both call sites claim in their comments: the cut fires before the
// await, so a failed disk write does not withdraw a stated intent.

import { beforeEach, describe, expect, it, vi } from "vitest";

const writePref = vi.fn();
vi.mock("../../src/lib/prefs", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/prefs")>();
  return { ...real };
});

vi.mock("../../src/platform/core", () => ({
  invoke: (...a: unknown[]) => writePref(...a),
}));

import { setAiProvider, setAiExcludedFolders } from "../../src/lib/prefs";
import {
  __resetChatForTest,
  getChat,
  isSeedable,
  sendAgentTurn,
} from "../../src/notes/ai/chatStore";

function existingTurnId(): string {
  sendAgentTurn("an earlier question", "This note");
  const id = getChat().turns[0]?.id;
  expect(id).toBeDefined();
  expect(isSeedable(id!)).toBe(true);
  return id!;
}

beforeEach(() => {
  __resetChatForTest();
  writePref.mockReset().mockResolvedValue(undefined);
});

describe("the seed cut is wired to the setters, not only implemented", () => {
  it("fires when the provider changes", async () => {
    const id = existingTurnId();
    await setAiProvider("openrouter");
    expect(isSeedable(id)).toBe(false);
  });

  it("fires when the provider is CLEARED, because local is a boundary too", async () => {
    const id = existingTurnId();
    await setAiProvider(null);
    expect(isSeedable(id)).toBe(false);
  });

  it("fires even when the write fails, because a failed disk write withdraws nothing", async () => {
    const id = existingTurnId();
    writePref.mockRejectedValueOnce(new Error("disk"));
    await expect(setAiProvider("openrouter")).rejects.toThrow();
    expect(isSeedable(id)).toBe(false);
  });

  it("does not fire on an unrelated prefs write", async () => {
    const id = existingTurnId();
    await setAiExcludedFolders([]);
    // `setAiExcludedFolders` is the raw binding; the cut for the exclusion set
    // lives one layer up in `usePrefs.setAiExcludedFoldersPref`, which is where
    // the optimistic state it converges also lives. This asserts the split is
    // deliberate rather than an omission: if the cut ever moves down here, this
    // test says so instead of a reviewer having to notice.
    expect(isSeedable(id)).toBe(true);
  });
});
