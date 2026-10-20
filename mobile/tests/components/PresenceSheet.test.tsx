// @vitest-environment jsdom
//
// The mobile presence roster sheet (myne-md/myne#849 task 6). The mobile twin of
// `tests/components/whoIsHereTab.test.tsx`, and the arms below are the ones the two
// clients must agree on: the store is the ONLY source of the list, a row's colour
// comes from the same source the caret does, an un-attributed peer renders the
// shared rule's degraded copy rather than an invented name, and being alone is an
// empty state that says so rather than an empty list.
//
// What this file CANNOT reach, stated rather than implied: no device and no second
// peer, so "a peer appears over the air" is the manual item, not a claim of this
// suite.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@myne/locales-en";
import type { IdentityLabel } from "@myne/identity-label";
import { colorVarForIndex, type Participant } from "@myne/participant";
import { clearAwareness, getAwarenessSnapshot, setAwareness } from "@myne/awareness-store";

// The real module is spread rather than replaced: `@myne/i18n` initializes i18next
// with `initReactI18next` at import time, and a wholesale mock leaves that undefined.
// The stub INTERPOLATES the one key that carries a value, so a `{{name}}` that
// stopped being substituted fails the accessible-name assertion below.
const i18nState = vi.hoisted(() => ({ lang: "en" }));

vi.mock("react-i18next", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-i18next")>();
  return {
    ...real,
    useTranslation: () => ({
      t: (key: string, vars?: Record<string, unknown>) => {
        // The `{{name}}` arm keeps the interpolation, so a template that stopped
        // being substituted fails the accessible-name assertion. Every other key
        // carries the LANGUAGE, which is what lets the switch test below assert
        // that the rendered string moved.
        if (vars !== undefined && typeof vars.name === "string") return `${key}:${vars.name}`;
        return `${i18nState.lang}::${key}`;
      },
      i18n: { language: i18nState.lang },
    }),
  };
});

import { PresenceSheet } from "../../src/app/flows/editor/sheets/PresenceSheet";

const text = (t: string): IdentityLabel => ({ kind: "text", text: t });

/** One peer, as the store holds it after a frame. */
function peer(over: Partial<Participant> & { id: string }): Participant {
  return {
    noteId: "n",
    label: null,
    unAttributed: true,
    caret: 0,
    selection: null,
    color: 0,
    ...over,
  };
}

/** Seed the shared store with peers keyed by note, which is how it is written. */
function seed(byNote: Record<string, Participant[]>) {
  setAwareness({
    peersByNote: new Map(
      Object.entries(byNote).map(([note, peers]) => [note, new Map(peers.map((p) => [p.id, p]))]),
    ),
    droppedAt: null,
  });
}

const onJump = vi.fn();
const onClose = vi.fn();

function renderSheet(noteId = "n") {
  return render(<PresenceSheet noteId={noteId} onJump={onJump} onClose={onClose} />);
}

/** Look a dotted key up in the real English catalog. */
function catalogValue(path: string): unknown {
  return path.split(".").reduce<unknown>((node, part) => {
    if (typeof node !== "object" || node === null) return undefined;
    return (node as Record<string, unknown>)[part];
  }, en);
}

afterEach(() => {
  cleanup();
  clearAwareness();
  i18nState.lang = "en";
  onJump.mockClear();
  onClose.mockClear();
});

describe("the empty state", () => {
  it("names the caller as alone rather than showing an empty list", () => {
    renderSheet();
    const empty = screen.getByTestId("editor.presence-empty");
    expect(empty).toBeTruthy();
    expect(screen.queryAllByTestId("editor.presence-row")).toHaveLength(0);
    // Reaches past the translator stub to the catalog, so a renamed key cannot
    // leave this green while the sheet renders the raw key (`mobile/AGENTS.md`).
    expect(catalogValue("editor.chrome.presence.empty")).toBe("You're the only one here");
  });
});

describe("a row per peer", () => {
  it("lists the peers of the note it was given, with the caret's own colour", () => {
    seed({
      n: [
        peer({ id: "a", label: text("Ada"), unAttributed: false, color: 2 }),
        peer({ id: "b", label: text("Bob"), unAttributed: false, color: 5 }),
      ],
    });
    renderSheet();

    const rows = screen.getAllByTestId("editor.presence-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();

    const dots = screen.getAllByTestId("editor.presence-dot");
    // The RENDERED background, not a `data-` copy of the same derivation: a second
    // attribute computed from `peer.color` is a second place the colour can be got
    // wrong, and asserting it is how this assertion was vacuous before injection
    // found it (jsdom keeps a `var(...)` string verbatim, so this compares the
    // string the component actually painted).
    expect(dots.map((d) => d.style.background)).toEqual([
      colorVarForIndex(2),
      colorVarForIndex(5),
    ]);
    expect(colorVarForIndex(2)).not.toBe(colorVarForIndex(5));
  });

  it("reads the store for ITS note and not another note's peers", () => {
    seed({ other: [peer({ id: "a", label: text("Ada"), unAttributed: false })] });
    renderSheet("n");
    expect(screen.queryAllByTestId("editor.presence-row")).toHaveLength(0);
    expect(screen.getByTestId("editor.presence-empty")).toBeTruthy();
  });

  it("empties when the store is CLEARED under it, without a remount", () => {
    // The third state the roster owes coverage for, and the one a vault lock
    // produces: the peers go and the sheet is still open (the lock path clears the
    // store, it does not unmount this sheet). Asserted through the store's own
    // accessor rather than a prop, because being driven by the store IS the claim.
    seed({ n: [peer({ id: "a", label: text("Ada"), unAttributed: false })] });
    renderSheet();
    expect(screen.getAllByTestId("editor.presence-row")).toHaveLength(1);

    act(() => {
      clearAwareness();
    });
    expect(screen.queryAllByTestId("editor.presence-row")).toHaveLength(0);
    expect(screen.getByTestId("editor.presence-empty")).toBeTruthy();
  });

  it("renders an un-attributed peer with the shared rule's degraded copy", () => {
    seed({ n: [peer({ id: "a", unAttributed: true, label: null })] });
    renderSheet();
    // The key, not a name: the point is that no invented name reaches the row.
    expect(screen.getByText("en::editor.chrome.presence.unknown")).toBeTruthy();
    expect(catalogValue("editor.chrome.presence.unknown")).toBe("Someone");
  });

  it("names the row's ACTION, so activating it is not announced as its contents", () => {
    seed({ n: [peer({ id: "a", label: text("Ada"), unAttributed: false })] });
    renderSheet();
    const row = screen.getByTestId("editor.presence-row");
    expect(row.getAttribute("role")).toBe("button");
    // The stub echoes the interpolated value, so a `{{name}}` that stopped being
    // substituted fails here.
    expect(row.getAttribute("aria-label")).toBe("editor.chrome.presence.jumpTo:Ada");
    expect(catalogValue("editor.chrome.presence.jumpTo")).toBe("Jump to {{name}}");
  });
});

describe("a peer's label is rendered, not stored as a string", () => {
  it("re-renders an already listed peer in the new language", () => {
    // A DEVICE label is the arm that carries our own copy (a person's name is the
    // user's own string and is rendered verbatim in every language), so it is the
    // one that can go stale.
    seed({
      n: [
        peer({
          id: "a",
          unAttributed: false,
          label: { kind: "device", code: "ABC123" },
        }),
      ],
    });
    const { rerender } = renderSheet();
    expect(screen.getByText("en::notes.snapshots.deviceFallback")).toBeTruthy();

    // What react-i18next does on a language change is re-render every consumer, so
    // this is the mechanism rather than a simulation of one.
    i18nState.lang = "tr";
    rerender(<PresenceSheet noteId="n" onJump={onJump} onClose={onClose} />);
    expect(screen.getByText("tr::notes.snapshots.deviceFallback")).toBeTruthy();
    expect(screen.queryByText("en::notes.snapshots.deviceFallback")).toBeNull();
  });

  it("keeps a user-authored name verbatim across a language switch", () => {
    seed({ n: [peer({ id: "a", unAttributed: false, label: text("Ada") })] });
    const { rerender } = renderSheet();
    expect(screen.getByText("Ada")).toBeTruthy();
    i18nState.lang = "tr";
    rerender(<PresenceSheet noteId="n" onJump={onJump} onClose={onClose} />);
    // The user's own string is not a translation and does not move.
    expect(screen.getByText("Ada")).toBeTruthy();
  });
});

describe("activation", () => {
  it("hands the peer to the jump path and closes the sheet", () => {
    seed({ n: [peer({ id: "a", label: text("Ada"), unAttributed: false, caret: 7 })] });
    // Fake timers FIRST: `Sheet`'s close is `setTimeout(onClose, SHEET_MS)`, so a
    // timer installed after the click is never advanced and this arm would pass
    // for the wrong reason.
    vi.useFakeTimers();
    renderSheet();
    fireEvent.click(screen.getByTestId("editor.presence-row"));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump.mock.calls[0][0]).toMatchObject({ id: "a", caret: 7 });
    // `Sheet` animates out before it calls `onClose`, which is why this is not
    // asserted synchronously with the click.
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("installs no follow mode: one activation, one call", () => {
    seed({ n: [peer({ id: "a", label: text("Ada"), unAttributed: false, caret: 3 })] });
    renderSheet();
    fireEvent.click(screen.getByTestId("editor.presence-row"));
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("still closes for a peer whose frame carried no position", () => {
    // The no-op for a peer with neither a caret nor a selection lives in the shared
    // `requestPresenceJump` (tests/notes/presenceJump.test.ts), so the desktop tab
    // and this sheet cannot disagree. What the sheet owes is acknowledging the tap.
    seed({ n: [peer({ id: "a", label: text("Ada"), unAttributed: false, caret: null, selection: null })] });
    vi.useFakeTimers();
    renderSheet();
    fireEvent.click(screen.getByTestId("editor.presence-row"));
    expect(onJump).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("jumps for a peer that has only a selection", () => {
    seed({
      n: [
        peer({
          id: "a",
          label: text("Ada"),
          unAttributed: false,
          caret: null,
          selection: { anchor: 4, head: 9 },
        }),
      ],
    });
    renderSheet();
    fireEvent.click(screen.getByTestId("editor.presence-row"));
    expect(onJump).toHaveBeenCalledTimes(1);
  });
});
