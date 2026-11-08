// @vitest-environment jsdom
//
// The presence side of the one label rule (`member-devices` task 5).
//
// Task 5's claim is a JOINT one: the participants list labels a peer by the same
// rule the version history uses. A test that rendered `<WhoIsHereTab>` with
// hand-written labels would prove nothing about that, since the roster renders
// whatever the store holds; so this spec drives the real path instead. It calls
// the very function `PaneView`'s effect calls (`resolvePeerLabels`) with a fake
// resolver standing in for the backend IPC, then renders the real roster over
// the real awareness store. The two fixtures are the two arms the task names: a
// peer with a binding (resolves to a `Person`, so the member's name), and a peer
// without one (resolves to an unnamed `Device`, so the device fallback).
//
// The last spec is the anti-drift half: whatever the history list and the roster
// show for the same identity must be the same string, asserted by running the
// shared rule rather than by restating its output.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../src/i18n";
import {
  awarenessClear,
  awarenessNotePeers,
  getAwarenessSnapshot,
  setAwareness,
} from "../../src/notes/collab/awarenessStore";
import { identityLabelText, resolvedIdentityLabel } from "../../src/notes/collab/identityLabel";
import { resolvePeerLabels } from "../../src/notes/collab/presenceLabels";
import type { Participant } from "../../src/notes/collab/participant";
import { WhoIsHereTab } from "../../src/notes/components/WhoIsHereTab";
import { EMPTY_SIDEBAR_STATE, SidebarStateProvider } from "../../src/notes/sidebarState";
import type { ResolvedIdentity } from "../../src/types/resolved-identity";

// The real translator, so the surface under test is handed the same thing the
// app hands it rather than a stub whose copy could differ from the shipped
// English (`i18n.t` IS a `TFunction`, which is the signature the rule takes).
const t = i18n.t;

vi.mock("../../src/notes/collab/presenceJump", () => ({
  PRESENCE_JUMP_EVENT: "myne-presence-jump",
  requestPresenceJump: vi.fn(),
}));

const BOUND = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNBOUND = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** The backend's answer for each actor, as `resolve_identity` returns it. */
const IDENTITIES: Record<string, ResolvedIdentity> = {
  // A device the vault holds a binding for: the join named the member.
  [BOUND]: { kind: "Person", name: "Ada" },
  // A device nobody bound and nobody labelled: the short-code fallback.
  [UNBOUND]: { kind: "Device", name: null, code: "bbbbbb" },
};

function resolver(seen: string[]) {
  return async (actorHex: string): Promise<ResolvedIdentity> => {
    seen.push(actorHex);
    return IDENTITIES[actorHex] ?? { kind: "Unknown" };
  };
}

/** Two un-attributed peers on the open note, the shape a presence frame carries. */
function seedPeers() {
  const peers: Participant[] = [
    {
      id: BOUND,
      noteId: "n",
      label: null,
      unAttributed: true,
      caret: 1,
      selection: null,
      color: 0,
    },
    {
      id: UNBOUND,
      noteId: "n",
      label: null,
      unAttributed: true,
      caret: 2,
      selection: null,
      color: 1,
    },
  ];
  setAwareness({
    peersByNote: new Map([["n", new Map(peers.map((p) => [p.id, p]))]]),
    droppedAt: null,
  });
}

function renderTab() {
  return render(
    <SidebarStateProvider initialState={{ ...EMPTY_SIDEBAR_STATE, selectedId: "n" }}>
      <WhoIsHereTab />
    </SidebarStateProvider>,
  );
}

afterEach(() => {
  cleanup();
  awarenessClear();
});

describe("resolvePeerLabels, the path PaneView's effect runs", () => {
  it("resolves each un-attributed peer once and writes the label into the store", async () => {
    seedPeers();
    const seen: string[] = [];
    await resolvePeerLabels(
      awarenessNotePeers(getAwarenessSnapshot(), "n").values(),
      resolver(seen),
    );

    // One resolver call per peer, no id hashed or interpreted here.
    expect(seen.sort()).toEqual([BOUND, UNBOUND]);
    const peers = awarenessNotePeers(getAwarenessSnapshot(), "n");
    expect(peers.get(BOUND)?.label).toEqual({ kind: "text", text: "Ada" });
    expect(peers.get(BOUND)?.unAttributed).toBe(false);
    expect(peers.get(UNBOUND)?.label).toEqual({ kind: "device", code: "bbbbbb" });
    expect(peers.get(UNBOUND)?.unAttributed).toBe(false);
  });

  it("does not re-resolve a peer that already carries a label", async () => {
    seedPeers();
    const seen: string[] = [];
    await resolvePeerLabels(
      awarenessNotePeers(getAwarenessSnapshot(), "n").values(),
      resolver(seen),
    );
    const first = seen.length;
    await resolvePeerLabels(
      awarenessNotePeers(getAwarenessSnapshot(), "n").values(),
      resolver(seen),
    );
    expect(seen.length).toBe(first);
  });

  it("leaves an Unknown peer un-attributed so the roster shows its degraded copy", async () => {
    const stranger = "cccccccccccccccccccccccccccccccc";
    setAwareness({
      peersByNote: new Map([
        [
          "n",
          new Map([
            [
              stranger,
              {
                id: stranger,
                noteId: "n",
                label: null,
                unAttributed: true,
                caret: null,
                selection: null,
                color: 2,
              } satisfies Participant,
            ],
          ]),
        ],
      ]),
      droppedAt: null,
    });
    await resolvePeerLabels(
      awarenessNotePeers(getAwarenessSnapshot(), "n").values(),
      resolver([]),
    );
    const peer = awarenessNotePeers(getAwarenessSnapshot(), "n").get(stranger);
    expect(peer?.label).toBeNull();
    expect(peer?.unAttributed).toBe(true);
  });

  it("survives a resolver rejection, leaving the peer for the next frame", async () => {
    seedPeers();
    const failing = async (): Promise<ResolvedIdentity> => {
      throw new Error("resolver hiccup");
    };
    await expect(
      resolvePeerLabels(awarenessNotePeers(getAwarenessSnapshot(), "n").values(), failing),
    ).resolves.toBeUndefined();
    expect(
      awarenessNotePeers(getAwarenessSnapshot(), "n").get(BOUND)?.unAttributed,
    ).toBe(true);
  });
});

describe("the roster a resolved presence produces", () => {
  it("labels a bound peer with the member's name and an unbound one with its device code", async () => {
    seedPeers();
    await resolvePeerLabels(
      awarenessNotePeers(getAwarenessSnapshot(), "n").values(),
      resolver([]),
    );
    renderTab();

    const rows = screen.getAllByTestId("editor.presence-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("Device bbbbbb")).toBeTruthy();
    expect(screen.queryByTestId("editor.presence-empty")).toBeNull();
    // Neither row carries a raw 32-hex actor id, in its copy OR in an attribute.
    // The sweep reads `outerHTML` rather than `textContent` because an attribute is
    // where an id lands naturally: the text-only version passed for the whole life
    // of `data-actor-id={participant.id}` on this very row (`member-devices` task 5
    // removed it, nothing having read it). The editor's own caret widget still
    // carries `data-participant-id`, which `e2e/collab-presence.e2e.ts` reads to
    // attribute a caret to a peer; that one is deliberate and outside this row.
    for (const row of rows) {
      expect(row.outerHTML).not.toMatch(/\b[0-9a-f]{32}\b/i);
    }
  });

  it("names one identity the same way the version history does", async () => {
    // The joint claim, asserted against the shared rule rather than a literal:
    // whatever the roster shows, the history list shows for the same identity. Both
    // sides go through the render half here too, because the descriptor is what the
    // store holds and a comparison of two descriptors would not notice a difference
    // that only appears once they are rendered.
    seedPeers();
    await resolvePeerLabels(
      awarenessNotePeers(getAwarenessSnapshot(), "n").values(),
      resolver([]),
    );
    renderTab();
    const peers = awarenessNotePeers(getAwarenessSnapshot(), "n");
    const bound = peers.get(BOUND);
    const unbound = peers.get(UNBOUND);
    expect(bound?.label).toEqual(resolvedIdentityLabel({ kind: "Person", name: "Ada" }));
    expect(unbound?.label).toEqual(
      resolvedIdentityLabel({ kind: "Device", name: null, code: "bbbbbb" }),
    );
    expect(identityLabelText(unbound!.label!, t)).toBe(
      identityLabelText(resolvedIdentityLabel({ kind: "Device", name: null, code: "bbbbbb" })!, t),
    );
    expect(screen.getByText("Device bbbbbb")).toBeTruthy();
  });

  it("re-renders a resolved label in the NEW language when the language changes", async () => {
    // The reason the rule hands back a descriptor rather than a string. The store is
    // module-scope and a peer's label is written once and never revisited, so a
    // rendered string there keeps the language the peer appeared in for as long as
    // that peer is present, while every other string on the screen follows the switch.
    //
    // The fixture INJECTS a catalog carrying the key, and that is deliberate rather
    // than convenient: `notes.snapshots.deviceFallback` exists in the English catalog
    // and in none of the 31 shipped translations (myne-agents/docs/dev/i18n-coverage.md), so every
    // real locale renders the English fallback and a switch to one of them would
    // produce the SAME string, leaving this assertion passing whether or not the
    // freeze was fixed. Injecting the bundle is exactly what shipping a translation
    // does, and it is the only version of this test that can fail.
    // No region subtag in the code, deliberately: i18next NORMALISES a tag, so a bundle
    // added under `xx-test` is looked up as `xx-Test`, misses, and silently falls through
    // to English, which would make this test pass without exercising anything.
    const CODE = "xx";
    i18n.addResourceBundle(CODE, "common", {
      notes: { snapshots: { deviceFallback: "Gerät {{code}}" } },
    });
    try {
      seedPeers();
      await resolvePeerLabels(
        awarenessNotePeers(getAwarenessSnapshot(), "n").values(),
        resolver([]),
      );
      renderTab();
      expect(screen.getByText("Device bbbbbb")).toBeTruthy();

      await i18n.changeLanguage(CODE);
      expect(screen.getByText("Gerät bbbbbb")).toBeTruthy();
      expect(screen.queryByText("Device bbbbbb")).toBeNull();
      // The name arm is a user's own words, so it does NOT move with the language.
      expect(screen.getByText("Ada")).toBeTruthy();
    } finally {
      await i18n.changeLanguage("en");
      i18n.removeResourceBundle(CODE, "common");
    }
  });
});
