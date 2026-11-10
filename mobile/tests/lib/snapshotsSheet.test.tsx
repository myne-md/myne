// @vitest-environment jsdom
// The phone's version history shows the DESKTOP's version history
// (myne-md/myne#1042).
//
// What the first mobile version did, and what each assertion below pins: it
// listed a timestamp and a size, opened a plain text box, and restored on one tap.
// The desktop diffed the revision against a basis the reader chooses, named the
// device the revision came from, and asked before overwriting the note. Two
// clients showing "the same" history and answering "what changed" differently is
// the defect; these four cases are the parts a reviewer can check without a vault.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const SNAPSHOTS = [
  {
    snapshot_uuid: "0191a000-0000-7000-8000-000000000002",
    captured_at_ms: Date.now() - 60_000,
    size_bytes: 2048,
    resolved_author: { kind: "Unknown" },
  },
  {
    snapshot_uuid: "0191a000-0000-7000-8000-000000000001",
    captured_at_ms: Date.now() - 3_600_000,
    size_bytes: 1024,
    resolved_author: { kind: "Device", name: null, code: "abc123" },
  },
];

const bodies = new Map<string, string>([
  ["0191a000-0000-7000-8000-000000000002", "one\ntwo\nthree"],
  ["0191a000-0000-7000-8000-000000000001", "one\ntwo"],
]);

const restore = vi.fn(async () => undefined);

vi.mock("../../src/lib/snapshots", () => ({
  snapshotList: async () => SNAPSHOTS,
  snapshotPreview: async (_noteId: string, uuid: string) => bodies.get(uuid) ?? "",
  snapshotRestore: (noteId: string, uuid: string) => restore(Note_and_uuid(noteId, uuid)),
}));

vi.mock("../../src/lib/notes", async (importActual) => ({
  ...(await importActual<typeof import("../../src/lib/notes")>()),
  noteRead: async () => "one\ntwo\nthree\nfour",
}));

vi.mock("../../src/lib/app-window", async (importActual) => ({
  ...(await importActual<typeof import("../../src/lib/app-window")>()),
  HAS_TAURI: true,
}));

import { SnapshotsSheet } from "../../src/app/flows/SnapshotsSheet";

/** `restore` is asserted through its arguments, so the mock needs them typed. */
function Note_and_uuid(noteId: string, uuid: string): { noteId: string; uuid: string } {
  return { noteId, uuid };
}

beforeEach(() => {
  restore.mockClear();
  cleanup();
});

function mount() {
  const onRestored = vi.fn();
  render(<SnapshotsSheet noteId="n1" noteTitle="Roadmap" onClose={() => {}} onRestored={onRestored} />);
  return { onRestored };
}

describe("SnapshotsSheet: the phone's version history", () => {
  it("names each revision's age, size and author", async () => {
    mount();
    const rows = await screen.findAllByTestId("snapshots.row");
    expect(rows).toHaveLength(2);
    // The unattributed revision says so, and the one carrying a device code says
    // that: the label rule is `@myne/identity-label`, the desktop's own.
    const authors = screen.getAllByTestId("snapshots.author").map((el) => el.textContent);
    expect(authors[0]).toBe("Unknown device");
    // The device code goes through the ONE key both clients use for it.
    expect(authors[1]).toBe("Device abc123");
    expect(rows[0]?.textContent).toContain("2 KB");
  });

  it("shows a DIFF of the chosen revision, not its raw text", async () => {
    mount();
    const rows = await screen.findAllByTestId("snapshots.row");
    fireEvent.click(rows[1]!);
    const diff = await screen.findByTestId("snapshots.diff");
    // `DiffView` paints one line per diff line, with the marker column; the plain
    // text box this replaced had none of that and could not say what changed.
    expect(diff.querySelectorAll('[data-mode]').length).toBeGreaterThan(0);
    expect(diff.textContent).toBeTruthy();
  });

  it("asks before restoring, and only then calls the backend", async () => {
    const { onRestored } = mount();
    fireEvent.click((await screen.findAllByTestId("snapshots.row"))[0]!);
    await screen.findByTestId("snapshots.diff");

    fireEvent.click(screen.getByTestId("snapshots.restore"));
    // The confirmation is a step, not a toast: nothing is written by the first press.
    expect(screen.getByTestId("snapshots.restore-confirm")).toBeTruthy();
    expect(restore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("snapshots.restore-confirm-cta"));
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    expect(restore).toHaveBeenCalledWith({
      noteId: "n1",
      uuid: "0191a000-0000-7000-8000-000000000002",
    });
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });

  it("says out loud that the oldest revision has nothing behind it", async () => {
    mount();
    const rows = await screen.findAllByTestId("snapshots.row");
    // The list is newest-first, so the OLDEST is the last row, and the revision it
    // was taken after is the one that does not exist.
    fireEvent.click(rows[1]!);
    await screen.findByTestId("snapshots.diff");
    fireEvent.click(screen.getByTestId("snapshots.compare-against-previous"));
    await screen.findByTestId("snapshots.no-previous");
  });
});
