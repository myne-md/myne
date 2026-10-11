// @vitest-environment jsdom
// The awareness decoration engine (`collab-presence-ui` task 2). The field is driven
// directly, no EditorView mount.

import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  awarenessDecorations,
  awarenessField,
  setAwareness,
  type AwarenessPeer,
} from "../../editor/src/decorations/awareness";
import {
  awarenessNotePeers,
  awarenessUpsert,
  EMPTY_AWARENESS,
} from "../../src/notes/collab/awarenessStore";

function peer(over: Partial<AwarenessPeer>): AwarenessPeer {
  return {
    id: "p1",
    noteId: "n1",
    label: "Ada",
    unAttributed: false,
    caret: null,
    selection: null,
    colorVar: "var(--group-olive)",
    ...over,
  };
}

function ranges(state: EditorState): Array<{
  from: number;
  to: number;
  cls?: string;
  label?: string;
}> {
  const set = state.field(awarenessField);
  const out: Array<{ from: number; to: number; cls?: string; label?: string }> = [];
  const iter = set.iter();
  while (iter.value) {
    const spec = iter.value.spec as {
      class?: string;
      widget?: { toDOM(): HTMLElement };
    };
    out.push({
      from: iter.from,
      to: iter.to,
      cls: spec.class,
      label: spec.widget?.toDOM().textContent ?? undefined,
    });
    iter.next();
  }
  return out;
}

function base(): EditorState {
  return EditorState.create({
    doc: "hello world\n",
    extensions: [awarenessDecorations()],
  });
}

describe("awareness decorations", () => {
  it("a caret is a point widget carrying its label; a selection is a range mark", () => {
    const state = base().update({
      effects: setAwareness.of({
        noteId: "n1",
        peers: [
          peer({ id: "a", caret: 3, selection: { anchor: 1, head: 5 } }),
          peer({ id: "b", label: "Bob", caret: 9 }),
        ],
      }),
    }).state;
    const r = ranges(state);
    const caretA = r.find((x) => x.from === 3 && x.to === 3);
    expect(caretA?.label).toBe("Ada");
    const selA = r.find((x) => x.from === 1 && x.to === 5);
    expect(selA?.cls).toBe("cm-awareness-selection");
    const caretB = r.find((x) => x.from === 9 && x.to === 9);
    expect(caretB?.label).toBe("Bob");
  });

  it("a peer bound to another note renders nothing", () => {
    const state = base().update({
      effects: setAwareness.of({
        noteId: "n1",
        peers: [peer({ noteId: "n2", caret: 3, selection: { anchor: 1, head: 5 } })],
      }),
    }).state;
    expect(ranges(state)).toHaveLength(0);
  });

  it("an absent push renders nothing and an empty list clears", () => {
    expect(ranges(base())).toHaveLength(0);
    const cleared = base().update({
      effects: setAwareness.of({ noteId: "n1", peers: [] }),
    }).state;
    expect(ranges(cleared)).toHaveLength(0);
    // An explicit undefined push clears a previously-populated field.
    const withPeer = base().update({
      effects: setAwareness.of({ noteId: "n1", peers: [peer({ caret: 3 })] }),
    }).state;
    expect(ranges(withPeer)).toHaveLength(1);
    const gone = withPeer.update({ effects: setAwareness.of(undefined) }).state;
    expect(ranges(gone)).toHaveLength(0);
  });

  it("marks survive a document change by mapping through it", () => {
    const state = base().update({
      effects: setAwareness.of({
        noteId: "n1",
        peers: [peer({ caret: 3, selection: { anchor: 2, head: 4 } })],
      }),
    }).state;
    // Insert one char at offset 0 → the caret and the selection both shift by 1.
    const shifted = state.update({ changes: { from: 0, insert: "X" } }).state;
    const r = ranges(shifted);
    expect(r.find((x) => x.from === 4 && x.to === 4)?.label).toBe("Ada");
    expect(r.find((x) => x.from === 3 && x.to === 5)?.cls).toBe("cm-awareness-selection");
  });

  it("draws a cursor for a supervisor-shaped JOIN frame (label null, cursor 0)", () => {
    // The hop the E2E could not see: the supervisor emits `{"noteId","actorId",
    // "label":null,"cursor":0,"selection":null,"frameType":"join"}` and the pane
    // passes it through `awarenessUpsert` + `paneAwareness` into this engine, so a
    // hand-built `AwarenessPeer` fixture (everything else in this file) never
    // exercises it. A null label must NOT suppress the cursor: an un-attributed peer
    // still has a position.
    const stored = awarenessUpsert(EMPTY_AWARENESS, {
      noteId: "n1",
      actorId: "device:a",
      label: null,
      cursor: 0,
      selection: null,
      frameType: "join",
    });
    const peers = [...awarenessNotePeers(stored, "n1").values()];
    expect(peers).toHaveLength(1);
    expect(peers[0].caret).toBe(0);
    expect(peers[0].unAttributed).toBe(true);
    const state = EditorState.create({ doc: "hello", extensions: [awarenessDecorations()] }).update({
      effects: setAwareness.of({
        noteId: "n1",
        peers: peers.map((p) => ({ ...p, colorVar: "var(--group-olive)" })),
      }),
    }).state;
    const drawn = ranges(state).filter((r) => r.label === "" || r.label === undefined);
    const set = state.field(awarenessField);
    const iter = set.iter();
    let cursors = 0;
    while (iter.value) {
      const spec = iter.value.spec as { widget?: { toDOM(): HTMLElement } };
      if (spec.widget?.toDOM().getAttribute("data-testid") === "editor.remote-cursor") {
        cursors += 1;
      }
      iter.next();
    }
    expect(drawn.length).toBeGreaterThan(0);
    expect(cursors, "a position-less label must not suppress the caret widget").toBe(1);
  });
});
