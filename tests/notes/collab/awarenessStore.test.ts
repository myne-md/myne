// The host awareness store (`collab-presence-ui` task 3).
//
// Peers are keyed by NOTE (`peersByNote`), so two panes on two notes never fight
// over one binding. These tests read each note's peers through
// `awarenessNotePeers`.

import { describe, expect, it } from "vitest";
import {
  AWARENESS_GRACE_MS,
  awarenessClear,
  awarenessDropPeer,
  awarenessNotePeers,
  awarenessOnDrop,
  awarenessSweep,
  awarenessUpsert,
  EMPTY_AWARENESS,
  type PresenceUpdate,
} from "../../../src/notes/collab/awarenessStore";

function update(over: Partial<PresenceUpdate>): PresenceUpdate {
  return {
    noteId: "note-1",
    actorId: "actor-a",
    label: "Ada",
    cursor: 3,
    selection: null,
    frameType: "presence",
    ...over,
  };
}

describe("awareness store", () => {
  it("keeps each note's peers separate (A never reaches B)", () => {
    let s = awarenessUpsert(EMPTY_AWARENESS, update({}));
    expect(awarenessNotePeers(s, "note-1").size).toBe(1);
    // A second note starts empty and does not disturb the first.
    expect(awarenessNotePeers(s, "note-2").size).toBe(0);
    s = awarenessUpsert(s, update({ noteId: "note-2", actorId: "z" }));
    expect(awarenessNotePeers(s, "note-1").size).toBe(1);
    expect(awarenessNotePeers(s, "note-2").size).toBe(1);
  });

  it("upserts per actor within a note", () => {
    let s = awarenessUpsert(EMPTY_AWARENESS, update({ actorId: "a", cursor: 1 }));
    s = awarenessUpsert(s, update({ actorId: "b", label: "Bob", cursor: 2 }));
    expect(awarenessNotePeers(s, "note-1").size).toBe(2);
    s = awarenessUpsert(s, update({ actorId: "a", cursor: 9 }));
    expect(awarenessNotePeers(s, "note-1").get("a")?.caret).toBe(9);
    expect(awarenessNotePeers(s, "note-1").size).toBe(2);
  });

  it("marks a label-less frame un-attributed", () => {
    const s = awarenessUpsert(EMPTY_AWARENESS, update({ actorId: "a", label: null }));
    expect(awarenessNotePeers(s, "note-1").get("a")?.unAttributed).toBe(true);
    expect(awarenessNotePeers(s, "note-1").get("a")?.label).toBeNull();
  });

  it("wraps a frame's own label as a TEXT descriptor, never as a bare string", () => {
    // A frame's label is already resolved by the backend, and it is a NAME the user
    // authored, so it has nothing to translate: it enters as `text`. What must not
    // happen is a raw string landing in `label`, because that is the shape that lets
    // a surface render half the rule (`identityLabel.ts`).
    const s = awarenessUpsert(EMPTY_AWARENESS, update({ actorId: "a", label: "Ada" }));
    expect(awarenessNotePeers(s, "note-1").get("a")?.label).toEqual({
      kind: "text",
      text: "Ada",
    });
  });

  it("normalizes a positional-array selection and rejects a malformed one", () => {
    // The wire used to send a Rust tuple, i.e. a JSON array. Left as-is it reached the
    // decoration builder, whose `.anchor` on an array is `undefined`, so `Math.min`
    // produced NaN and the whole dispatch threw.
    const arrayish = awarenessUpsert(EMPTY_AWARENESS, {
      ...update({ actorId: "a" }),
      selection: [2, 5] as unknown as { anchor: number; head: number },
    });
    expect(awarenessNotePeers(arrayish, "note-1").get("a")?.selection).toEqual({
      anchor: 2,
      head: 5,
    });
    const objectish = awarenessUpsert(EMPTY_AWARENESS, update({ actorId: "b" }));
    expect(awarenessNotePeers(objectish, "note-1").get("b")?.selection).toBeNull();
    const malformed = awarenessUpsert(EMPTY_AWARENESS, {
      ...update({ actorId: "c" }),
      selection: { anchor: 1 } as unknown as { anchor: number; head: number },
    });
    expect(awarenessNotePeers(malformed, "note-1").get("c")?.selection).toBeNull();
  });

  it("drops one peer on leave, from every note", () => {
    let s = awarenessUpsert(EMPTY_AWARENESS, update({ actorId: "a" }));
    s = awarenessUpsert(s, update({ actorId: "b" }));
    s = awarenessUpsert(s, update({ noteId: "note-2", actorId: "a" }));
    s = awarenessDropPeer(s, "a");
    expect([...awarenessNotePeers(s, "note-1").keys()]).toEqual(["b"]);
    expect(awarenessNotePeers(s, "note-2").size).toBe(0);
  });

  it("holds peers through the grace window on a drop, then clears", () => {
    let s = awarenessUpsert(EMPTY_AWARENESS, update({}));
    s = awarenessOnDrop(s, 1000);
    // Before the window: held.
    s = awarenessSweep(s, 1000 + AWARENESS_GRACE_MS - 1);
    expect(awarenessNotePeers(s, "note-1").size).toBe(1);
    // At/after the window: cleared.
    s = awarenessSweep(s, 1000 + AWARENESS_GRACE_MS);
    expect(awarenessNotePeers(s, "note-1").size).toBe(0);
    expect(s.droppedAt).toBeNull();
  });

  it("a frame arriving after a drop cancels it (reconnect does not flicker)", () => {
    let s = awarenessUpsert(EMPTY_AWARENESS, update({}));
    s = awarenessOnDrop(s, 1000);
    s = awarenessUpsert(s, update({ cursor: 5 }));
    expect(s.droppedAt).toBeNull();
    expect(awarenessNotePeers(s, "note-1").size).toBe(1);
  });

  it("clears immediately on lock / vault leave", () => {
    let s = awarenessUpsert(EMPTY_AWARENESS, update({}));
    s = awarenessClear();
    expect(s.peersByNote.size).toBe(0);
  });
});
