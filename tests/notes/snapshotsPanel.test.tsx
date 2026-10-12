// @vitest-environment jsdom
//
// `<SnapshotsPanel>` compare-against selector (MYND-334 task 6). What the
// selector changes is the diff's BASIS, and getting the basis wrong is
// invisible on screen — both bases render an identical-looking unified diff —
// so the assertions here are about which two bodies were fed to the diff and
// which snapshot was decrypted to get them.
//
// The list is newest-first, so the snapshot "before" the selected one is the
// NEXT list entry. The oldest snapshot has no predecessor; that case gets a
// sentence, not an empty diff. Restore is untouched by any of this and is
// re-asserted here so the enrichment can't quietly alter recovery.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SnapshotsPanel } from "../../src/notes/components/SnapshotsPanel";
import type { SnapshotMeta } from "../../src/types/snapshot-error";

vi.mock("../../src/notes/snapshots", () => ({
  snapshotList: vi.fn(),
  snapshotPreview: vi.fn(),
  snapshotRestore: vi.fn(),
  snapshotPrune: vi.fn(),
}));
vi.mock("../../src/notes/readNote", () => ({ noteRead: vi.fn() }));

import {
  snapshotList,
  snapshotPreview,
  snapshotRestore,
} from "../../src/notes/snapshots";
import { noteRead } from "../../src/notes/readNote";

const listMock = vi.mocked(snapshotList);
const previewMock = vi.mocked(snapshotPreview);
const restoreMock = vi.mocked(snapshotRestore);
const readMock = vi.mocked(noteRead);

afterEach(cleanup);

// Three snapshots, newest-first — the order `snapshot_list` returns.
const SNAPS: SnapshotMeta[] = [
  {
    snapshot_uuid: "s-newest",
    captured_at_ms: 3_000,
    size_bytes: 300,
    resolved_author: { kind: "Unknown" },
  },
  {
    snapshot_uuid: "s-middle",
    captured_at_ms: 2_000,
    size_bytes: 200,
    resolved_author: { kind: "Unknown" },
  },
  {
    snapshot_uuid: "s-oldest",
    captured_at_ms: 1_000,
    size_bytes: 100,
    resolved_author: { kind: "Unknown" },
  },
];

const BODY: Record<string, string> = {
  "s-newest": "the quick brown fox\nline two\n",
  "s-middle": "the slow brown fox\nline two\n",
  "s-oldest": "the slow brown dog\nline two\n",
};

const CURRENT = "the quick red fox\nline two\n";

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue(SNAPS);
  previewMock.mockImplementation(async (_noteId, uuid) => BODY[uuid] ?? "");
  readMock.mockResolvedValue(CURRENT);
  restoreMock.mockResolvedValue(undefined);
});

function renderPanel() {
  return render(
    <SnapshotsPanel open onClose={() => {}} noteId="note-1" noteTitle="Note" />,
  );
}

/** Click a row by its snapshot id and wait for the diff to paint. */
async function selectRow(uuid: string) {
  const rows = await screen.findAllByTestId("snapshots.row");
  const target = rows.find((r) => r.getAttribute("data-snapshot-id") === uuid);
  expect(target, `row for ${uuid}`).toBeDefined();
  fireEvent.click(target!);
  await screen.findByTestId("snapshots.preview");
}

/** Drive the `<Select>` trigger: open the menu, click the option by value. */
async function chooseBasis(value: "current" | "previous") {
  fireEvent.click(screen.getByTestId("snapshots.compare-against"));
  const options = await screen.findAllByTestId("snapshots.compare-against-option");
  const opt = options.find((o) => o.getAttribute("data-value") === value);
  expect(opt, `option ${value}`).toBeDefined();
  fireEvent.click(opt!);
}

/** The rendered diff, as `[type, text]` pairs with the gutter marker stripped. */
function diffPairs(): Array<[string, string]> {
  return screen
    .getAllByTestId("diff.line")
    .map((l) => [
      l.getAttribute("data-type") ?? "",
      (l.textContent ?? "").slice(2),
    ]);
}

describe("<SnapshotsPanel> — compare-against selector", () => {
  it("shows the selector, defaulting to the current note", async () => {
    renderPanel();
    await selectRow("s-newest");
    const trigger = screen.getByTestId("snapshots.compare-against");
    expect(trigger.textContent).toContain("Current note");
    expect(screen.getByTestId("snapshots.preview").getAttribute("data-compare-against")).toBe(
      "current",
    );
  });

  it("diffs the selected snapshot against the current note by default", async () => {
    renderPanel();
    await selectRow("s-newest");
    // s-newest "quick brown" -> current "quick red": one refined line pair.
    expect(diffPairs()).toEqual([
      ["del", "the quick brown fox"],
      ["add", "the quick red fox"],
      ["same", "line two"],
      ["same", ""],
    ]);
    expect(readMock).toHaveBeenCalledWith("note-1");
  });

  it("recomputes against the prior list entry when switched to previous", async () => {
    renderPanel();
    await selectRow("s-middle");
    await chooseBasis("previous");

    // s-middle's predecessor is the NEXT list entry (older): s-oldest.
    await waitFor(() => expect(previewMock).toHaveBeenCalledWith("note-1", "s-oldest"));
    await waitFor(() =>
      expect(diffPairs()).toEqual([
        ["del", "the slow brown dog"],
        ["add", "the slow brown fox"],
        ["same", "line two"],
        ["same", ""],
      ]),
    );
    expect(screen.getByTestId("snapshots.preview").getAttribute("data-compare-against")).toBe(
      "previous",
    );
  });

  it("keeps the word-level highlight on the recomputed diff", async () => {
    renderPanel();
    await selectRow("s-middle");
    await chooseBasis("previous");
    await waitFor(() => expect(previewMock).toHaveBeenCalledWith("note-1", "s-oldest"));

    const del = await waitFor(() => {
      const line = screen
        .getAllByTestId("diff.line")
        .find((l) => l.getAttribute("data-type") === "del");
      expect(line).toBeDefined();
      return line!;
    });
    const marked = within(del)
      .getAllByTestId("diff.segment")
      .filter((s) => s.getAttribute("data-type") === "del")
      .map((s) => s.textContent);
    expect(marked).toEqual(["dog"]);
  });

  it("does not decrypt anything extra while the basis is the current note", async () => {
    renderPanel();
    await selectRow("s-middle");
    expect(previewMock.mock.calls.map((c) => c[1])).toEqual(["s-middle"]);
  });

  it("says so, and renders no diff, when the oldest snapshot has no predecessor", async () => {
    renderPanel();
    await selectRow("s-oldest");
    await chooseBasis("previous");

    const note = await screen.findByTestId("snapshots.no-previous");
    expect(note.textContent).toContain("earliest snapshot");
    expect(screen.queryAllByTestId("diff.line")).toHaveLength(0);
    // Nothing beyond the selected snapshot itself was decrypted.
    expect(previewMock.mock.calls.map((c) => c[1])).toEqual(["s-oldest"]);
  });

  it("keeps the chosen basis when another snapshot is selected", async () => {
    renderPanel();
    await selectRow("s-middle");
    await chooseBasis("previous");
    await waitFor(() => expect(previewMock).toHaveBeenCalledWith("note-1", "s-oldest"));

    await selectRow("s-newest");
    await waitFor(() => expect(previewMock).toHaveBeenCalledWith("note-1", "s-middle"));
    await waitFor(() =>
      expect(diffPairs()).toEqual([
        ["del", "the slow brown fox"],
        ["add", "the quick brown fox"],
        ["same", "line two"],
        ["same", ""],
      ]),
    );
  });

  it("surfaces a failure to decrypt the older snapshot without hiding Restore", async () => {
    renderPanel();
    await selectRow("s-middle");
    previewMock.mockRejectedValueOnce({ kind: "CannotDecrypt" });
    await chooseBasis("previous");

    await waitFor(() =>
      expect(
        within(screen.getByTestId("snapshots.preview")).getByText(
          /couldn't be decrypted/i,
        ),
      ).toBeDefined(),
    );
    expect(screen.getByTestId("snapshots.restore")).toBeDefined();
  });

  it("leaves the Restore flow untouched — confirm still restores the selected snapshot", async () => {
    renderPanel();
    await selectRow("s-middle");
    await chooseBasis("previous");

    fireEvent.click(screen.getByTestId("snapshots.restore"));
    await screen.findByTestId("snapshots.restore-confirm");
    fireEvent.click(screen.getByTestId("snapshots.restore-confirm-cta"));

    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith("note-1", "s-middle"));
  });
});

describe("<SnapshotsPanel>, resolved author (collab-provenance)", () => {
  it("renders the author as a name, never a raw id or hash, with Unknown as copy", async () => {
    renderPanel();
    const authors = await screen.findAllByTestId("snapshots.author");
    expect(authors.length).toBeGreaterThan(0);
    // The fixture's revisions resolve to `unknown` → the localized copy.
    expect(authors[0]?.textContent).toBe("Unknown device");
    expect(authors[0]?.getAttribute("data-author-kind")).toBe("Unknown");
    // No raw 32-hex actor id or hash reaches the DOM.
    expect(document.body.innerHTML).not.toMatch(/\b[0-9a-f]{32}\b/i);
  });
});
