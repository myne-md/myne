// @vitest-environment jsdom
//
// The stage ↔ history binding (phase3-web-client task 64).
//
// `tests/web/history-seam.test.ts` asserts what the browser arm does with a
// URL. This file asserts the part that is NOT platform-specific: which
// transitions become history entries, which are merely recorded, and what a
// back press is allowed to do to an app whose vault is unlocked.
//
// The seam is faked rather than mocked-at-the-browser deliberately — these
// rules must hold identically on both arms, and on desktop every seam call is a
// no-op, which is the whole of "desktop behaviour unchanged".

import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "../../src/platform/history";

// ── the fake seam ───────────────────────────────────────────────────────────
let bootRoute: Route | null = null;
const calls: Array<{ op: "push" | "replace"; route: Route }> = [];
let listener: ((r: Route) => void) | null = null;

vi.mock("../../src/platform/history", () => ({
  readRoute: () => bootRoute,
  pushRoute: (route: Route) => {
    calls.push({ op: "push", route });
  },
  replaceRoute: (route: Route) => {
    calls.push({ op: "replace", route });
  },
  onRouteChange: (handler: (r: Route) => void) => {
    listener = handler;
    return () => {
      listener = null;
    };
  },
}));

const { __resetRoutingForTest, takeDeepLinkNoteId, useNoteRoute, useStageRoute } =
  await import("../../src/lib/routing");

const NOTE = "0199c1de-7b3a-7000-8000-0123456789ab";
const OTHER = "0199c1de-7b3a-7000-8000-ba9876543210";

beforeEach(() => {
  bootRoute = null;
  calls.length = 0;
  listener = null;
  __resetRoutingForTest();
});

function pop(route: Route): void {
  act(() => {
    listener?.(route);
  });
}

// A component per hook, so a test drives exactly one binding.
function StageHarness({ stage, reprobe }: { stage: string | null; reprobe: () => void }) {
  useStageRoute(stage as never, reprobe);
  return null;
}

function NoteHarness(props: {
  active: boolean;
  selectedId: string | null;
  select: (id: string | null) => void;
}) {
  useNoteRoute(props);
  return null;
}

describe("the boot deep link", () => {
  it("is read once and consumed once", () => {
    bootRoute = { name: "editor", noteId: NOTE };
    expect(takeDeepLinkNoteId()).toBe(NOTE);
    expect(takeDeepLinkNoteId()).toBeNull();
  });

  it("is null when the client was opened at a plain stage", () => {
    bootRoute = { name: "unlock" };
    expect(takeDeepLinkNoteId()).toBeNull();
  });
});

describe("useStageRoute", () => {
  it("records nothing while the boot probe is in flight", () => {
    render(<StageHarness stage={null} reprobe={() => {}} />);
    expect(calls).toEqual([]);
  });

  it("REPLACES the first stage and PUSHES the ones after it", () => {
    // The stage you boot into is where you already are — recording it as a new
    // entry would cost a back press to leave a screen you never navigated to.
    const { rerender } = render(<StageHarness stage="welcome" reprobe={() => {}} />);
    expect(calls).toEqual([{ op: "replace", route: { name: "welcome" } }]);
    rerender(<StageHarness stage="create-vault" reprobe={() => {}} />);
    expect(calls[1]).toEqual({ op: "push", route: { name: "create-vault" } });
  });

  it("holds the URL while a deep link is unconsumed", () => {
    // A reload always locks a browser client (the keys live in RAM), so the
    // reload path IS the deep-link path: rewriting the address bar to /unlock
    // here would throw away the note the user bookmarked.
    bootRoute = { name: "editor", noteId: NOTE };
    render(<StageHarness stage="unlock" reprobe={() => {}} />);
    expect(calls).toEqual([]);
    expect(takeDeepLinkNoteId()).toBe(NOTE);
  });

  it("never records the editor stage — the note binding owns that URL", () => {
    render(<StageHarness stage="editor" reprobe={() => {}} />);
    expect(calls).toEqual([]);
  });

  it("re-probes on a back press to a different pre-unlock stage", () => {
    // Route → Stage is lossy by construction (a Stage carries mount-time
    // payload a URL must never hold), so back does not reconstruct a stage: it
    // asks the boot probe where the app actually belongs — the same door the
    // create screen's own Back button already uses.
    const reprobe = vi.fn();
    render(<StageHarness stage="create-vault" reprobe={reprobe} />);
    pop({ name: "welcome" });
    expect(reprobe).toHaveBeenCalledTimes(1);
  });

  it("ignores a back press that names the stage already showing", () => {
    const reprobe = vi.fn();
    render(<StageHarness stage="picker" reprobe={reprobe} />);
    pop({ name: "picker" });
    expect(reprobe).not.toHaveBeenCalled();
  });

  it("never re-probes out of the editor", () => {
    // Back is not a lock affordance. Re-probing here would show a locked
    // screen over a live unlocked slot, and forward would walk back in without
    // a password.
    const reprobe = vi.fn();
    render(<StageHarness stage="editor" reprobe={reprobe} />);
    pop({ name: "unlock" });
    expect(reprobe).not.toHaveBeenCalled();
  });
});

describe("useNoteRoute", () => {
  it("records nothing until the deep link has settled", () => {
    render(<NoteHarness active={false} selectedId={NOTE} select={() => {}} />);
    expect(calls).toEqual([]);
  });

  it("does not answer a back press until the deep link has settled", () => {
    // The window between the editor mounting and `note_list` returning. A
    // refusal-push here (see the last test) would overwrite the destination URL
    // with the empty editor, throwing away the note the user came back for.
    const select = vi.fn();
    render(<NoteHarness active={false} selectedId={null} select={select} />);
    pop({ name: "welcome" });
    expect(select).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("replaces on the first record and pushes on every later selection", () => {
    const { rerender } = render(
      <NoteHarness active selectedId={null} select={() => {}} />,
    );
    expect(calls).toEqual([{ op: "replace", route: { name: "editor" } }]);
    rerender(<NoteHarness active selectedId={NOTE} select={() => {}} />);
    expect(calls[1]).toEqual({ op: "push", route: { name: "editor", noteId: NOTE } });
    rerender(<NoteHarness active selectedId={OTHER} select={() => {}} />);
    expect(calls[2]).toEqual({ op: "push", route: { name: "editor", noteId: OTHER } });
  });

  it("opens the note a back press names", () => {
    const select = vi.fn();
    render(<NoteHarness active selectedId={OTHER} select={select} />);
    pop({ name: "editor", noteId: NOTE });
    expect(select).toHaveBeenCalledWith(NOTE);
  });

  it("clears the selection for a note-less editor entry", () => {
    const select = vi.fn();
    render(<NoteHarness active selectedId={NOTE} select={select} />);
    pop({ name: "editor" });
    expect(select).toHaveBeenCalledWith(null);
  });

  it("does not re-select the note already open", () => {
    const select = vi.fn();
    render(<NoteHarness active selectedId={NOTE} select={select} />);
    pop({ name: "editor", noteId: NOTE });
    expect(select).not.toHaveBeenCalled();
  });

  it("refuses to leave an unlocked vault, and says so in the URL", () => {
    // The counterpart of useStageRoute's "never re-probes out of the editor":
    // somebody has to put the address bar back, and only this hook knows which
    // note is open.
    const select = vi.fn();
    render(<NoteHarness active selectedId={NOTE} select={select} />);
    calls.length = 0;
    pop({ name: "welcome" });
    expect(select).not.toHaveBeenCalled();
    expect(calls).toEqual([{ op: "push", route: { name: "editor", noteId: NOTE } }]);
  });
});
