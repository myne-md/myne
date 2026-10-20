// @vitest-environment jsdom
//
// Mobile's peer-label resolution (myne-md/myne#849 task 7). The mobile twin of the
// desktop pane's `resolvePeerLabels` effect, and what it pins is that the RULE is
// shared while the RESOLVER is this client's:
//
//   1. the actor id goes to the backend resolver verbatim, so no id is hashed,
//      truncated or otherwise interpreted here;
//   2. a resolved peer's row carries that name;
//   3. a peer the resolver answers `Unknown` for stays UN-ATTRIBUTED and renders the
//      shared rule's degraded copy, never a name. A roster row is not evidence of
//      authorship (`decisions/protocol/0669`), so this arm is the security half of
//      the task rather than a display detail;
//   4. what is written into the store is a DESCRIPTOR, and the string is produced at
//      render time, which is what makes a language switch move an already listed
//      peer.
//
// What this file CANNOT reach, stated rather than implied: the real resolver. It is
// the backend's, over `plugin:sync|resolve_identity`, so "a peer's name appears" on a
// device is the manual item.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Mutable so a test can simulate react-i18next's language switch, which
 *  re-renders every `useTranslation` consumer. */
const i18nState = vi.hoisted(() => ({ lang: "en" }));

vi.mock("react-i18next", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-i18next")>();
  return {
    ...real,
    useTranslation: () => ({
      // Echoes the key AND the interpolation, so a `{{code}}` that stopped being
      // substituted fails the text assertions rather than passing as a key.
      t: (key: string, vars?: Record<string, unknown>) =>
        `${i18nState.lang}::${key}::${JSON.stringify(vars ?? {})}`,
      i18n: { language: i18nState.lang },
    }),
  };
});

const resolveIdentity = vi.fn<(actorHex: string) => Promise<unknown>>();
vi.mock("../src/lib/identity", () => ({
  resolveIdentity: (actorHex: string) => resolveIdentity(actorHex),
}));

import { clearAwareness, awarenessNotePeers, getAwarenessSnapshot, setAwareness } from "@myne/awareness-store";
import { useAwarenessLabelResolution, useAwarenessPeers } from "../src/lib/awareness";

/** The actor hex a frame carries, verbatim. */
const ACTOR = "a1b2c3d4e5f60718";

function seedPeer(noteId: string) {
  setAwareness({
    peersByNote: new Map([[noteId, new Map([[ACTOR, { id: ACTOR, noteId, label: null, unAttributed: true, caret: 3, selection: null, color: 1 }]])]]),
    droppedAt: null,
  });
}

/** Mount the resolution effect plus a read of the peers it attributes. */
function mountResolving(noteId: string | null = "n") {
  return renderHook(() => {
    useAwarenessLabelResolution(noteId);
    return useAwarenessPeers(noteId);
  });
}

/** Let the effect's awaited resolver chain and the store write settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  clearAwareness();
  resolveIdentity.mockReset();
  i18nState.lang = "en";
});

afterEach(cleanup);

describe("the resolver is this client's binding", () => {
  it("passes the actor id verbatim, with no hashing or truncation on the client", async () => {
    resolveIdentity.mockResolvedValue({ kind: "Person", name: "Ada" });
    seedPeer("n");
    mountResolving();
    await settle();
    expect(resolveIdentity).toHaveBeenCalledWith(ACTOR);
    // The store's key is still the raw id the frame carried.
    expect([...awarenessNotePeers(getAwarenessSnapshot(), "n").keys()]).toEqual([ACTOR]);
  });

  it("attributes the peer and leaves the descriptor, not a rendered string, in the store", async () => {
    const { result } = await (async () => {
      resolveIdentity.mockResolvedValue({ kind: "Device", name: null, code: "ABC123" });
      seedPeer("n");
      return mountResolving();
    })();
    await settle();

    const peer = result.current[0];
    expect(peer.unAttributed).toBe(false);
    // The DESCRIPTOR, deliberately: a string here would pin the language the peer
    // appeared in for the life of the peer (`identityLabel.ts`).
    expect(peer.label).toEqual({ kind: "device", code: "ABC123" });
    expect(typeof peer.label).not.toBe("string");
  });

  it("does not re-resolve a peer the store has already attributed", async () => {
    resolveIdentity.mockResolvedValue({ kind: "Person", name: "Ada" });
    seedPeer("n");
    const { rerender } = mountResolving();
    await settle();
    expect(resolveIdentity).toHaveBeenCalledTimes(1);
    // A second pass with the SAME store state is what the effect's dependency on
    // `awareness` produces on any unrelated store write (another note's frame).
    rerender();
    await settle();
    expect(resolveIdentity).toHaveBeenCalledTimes(1);
  });
});

describe("an unverified peer is never given a name", () => {
  it("leaves the peer un-attributed when the resolver answers Unknown", async () => {
    resolveIdentity.mockResolvedValue({ kind: "Unknown" });
    seedPeer("n");
    const { result } = mountResolving();
    await settle();

    const peer = result.current[0];
    expect(peer.unAttributed).toBe(true);
    expect(peer.label).toBeNull();
  });

  it("leaves the peer un-attributed when the resolver rejects", async () => {
    resolveIdentity.mockRejectedValue(new Error("no session"));
    seedPeer("n");
    const { result } = mountResolving();
    await settle();
    // Not a crash and not a name: the next frame retries, and the surface keeps
    // rendering the degraded copy meanwhile.
    expect(result.current[0].unAttributed).toBe(true);
    expect(result.current[0].label).toBeNull();
  });
});

describe("what reaches the store", () => {
  it("is a descriptor, so a rendered string cannot outlive the language", async () => {
    resolveIdentity.mockResolvedValue({ kind: "Device", name: null, code: "ABC123" });
    seedPeer("n");
    const { result } = mountResolving();
    await settle();
    expect(result.current[0].label).toEqual({ kind: "device", code: "ABC123" });

    // The store does not move when the language does; the descriptor is what makes
    // that safe. The RENDERED string moving with the language is asserted where a
    // string exists at all (`tests/components/PresenceSheet.test.tsx`).
    i18nState.lang = "tr";
    expect(getAwarenessSnapshot().peersByNote.get("n")?.get(ACTOR)?.label).toEqual({
      kind: "device",
      code: "ABC123",
    });
  });
});
