// @vitest-environment jsdom
//
// The shared roster jump (`src/notes/collab/presenceJump.ts`), which both the
// desktop "Who's here" tab and the mobile presence sheet call. The no-position
// arm lives here rather than at either roster's row so the two cannot disagree
// (myne-md/myne#849 review): a peer whose frame carried neither a caret nor a
// selection has nothing to reveal, and the old `?? 0` scrolled to the top.

import { afterEach, describe, expect, it } from "vitest";
import {
  PRESENCE_JUMP_EVENT,
  requestPresenceJump,
  type PresenceJumpDetail,
} from "../../src/notes/collab/presenceJump";
import type { Participant } from "../../src/notes/collab/participant";

const seen: PresenceJumpDetail[] = [];
const onJump = (e: Event) => seen.push((e as CustomEvent<PresenceJumpDetail>).detail);
window.addEventListener(PRESENCE_JUMP_EVENT, onJump);

afterEach(() => {
  seen.length = 0;
});

function participant(over: Partial<Participant>): Participant {
  return { caret: null, selection: null, ...over } as Participant;
}

describe("requestPresenceJump", () => {
  it("jumps to the caret", () => {
    requestPresenceJump("n", participant({ caret: 12 }));
    expect(seen).toEqual([{ noteId: "n", offset: 12 }]);
  });

  it("falls back to the selection head", () => {
    requestPresenceJump("n", participant({ selection: { anchor: 3, head: 7 } } as Partial<Participant>));
    expect(seen).toEqual([{ noteId: "n", offset: 7 }]);
  });

  it("does nothing for a peer with neither a caret nor a selection", () => {
    requestPresenceJump("n", participant({}));
    expect(seen).toEqual([]);
  });

  it("does nothing with no note on screen", () => {
    requestPresenceJump(null, participant({ caret: 4 }));
    expect(seen).toEqual([]);
  });
});
