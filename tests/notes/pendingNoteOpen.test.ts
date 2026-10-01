// The one-shot "open this note when the editor next mounts" handoff for the
// plain-file Import action (myne-md/myne#788, task 9).
//
// The plain surface renders INSTEAD of the vault stage, so when Import creates
// a note the Editor is unmounted and no React context reaches the caller. The
// request is module state consumed exactly once by the next editor mount; an
// id that is not in the live list by then is dropped by the consumer.

import { beforeEach, describe, expect, it } from "vitest";
import {
  requestNoteOpen,
  takeRequestedNoteOpen,
  __resetPendingNoteOpenForTest,
} from "../../src/notes/pendingNoteOpen";

describe("pendingNoteOpen", () => {
  beforeEach(() => __resetPendingNoteOpenForTest());

  it("is null until a request is made", () => {
    expect(takeRequestedNoteOpen()).toBeNull();
  });

  it("hands the id back exactly once", () => {
    requestNoteOpen("note-1");
    expect(takeRequestedNoteOpen()).toBe("note-1");
    expect(takeRequestedNoteOpen()).toBeNull();
  });

  it("a later request wins the single slot", () => {
    requestNoteOpen("note-1");
    requestNoteOpen("note-2");
    expect(takeRequestedNoteOpen()).toBe("note-2");
    expect(takeRequestedNoteOpen()).toBeNull();
  });
});
