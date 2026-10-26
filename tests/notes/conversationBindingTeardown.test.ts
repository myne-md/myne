// Lock teardown drops the conversation binding (myne-md/myne#913, review round
// three).
//
// The pin and the deferred switch are session state held in a module
// (`conversationBinding.ts`) rather than in the panel, because the panel unmounts
// on every right-panel tab switch. Session state in a module has one hazard the
// component version did not: nothing unmounts it. `clearAgentForLock` is the
// boundary, and this test is what makes the sentence in that module true: a
// pinned conversation is not carried into the next unlock, and a switch recorded
// during a run does not fire against a vault the user has just opened.
//
// Deleting the `resetConversationBinding()` call from `clearAgentForLock` must
// redden this file. That is the only reason it exists.

import { afterEach, describe, expect, it } from "vitest";

import {
  conversationNoteId,
  keepConversationPinned,
  requestNoteSwitch,
  setConversationNote,
  setKeepConversationPinned,
  takeNoteSwitch,
} from "../../src/notes/ai/conversationBinding";
import { clearAgentForLock } from "../../src/notes/agent/agentStore";

afterEach(() => {
  clearAgentForLock();
});

describe("a lock ends the conversation binding", () => {
  it("drops the pin, the pending switch and the bound note", () => {
    setKeepConversationPinned(true);
    requestNoteSwitch();
    setConversationNote("note-a");
    expect(keepConversationPinned()).toBe(true);
    expect(conversationNoteId()).toBe("note-a");

    clearAgentForLock();

    expect(keepConversationPinned()).toBe(false);
    expect(conversationNoteId()).toBeNull();
    // Taken by teardown rather than left pending: a late settle after the
    // unlock must not clear a brand-new conversation.
    expect(takeNoteSwitch()).toBe(false);
  });
});
