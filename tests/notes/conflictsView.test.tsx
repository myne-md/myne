// @vitest-environment jsdom
//
// `<ConflictsView>` render + interaction tests (MYND-427 task 4). The view is
// the dedicated surface for sync conflict copies (the keep-both `conflict:`
// notes), grouped by the original they forked from (`conflict_of:`). Behavior-
// level: render with a fabricated grouped conflict set (`Map<originalUuid,
// TitleRecord[]>`) and assert one group per Map entry, one copy row per record
// (with its `data-note-id`), the title / "Untitled" fallback, the pluralized
// group heading, the empty state, and that the Keep-as-separate / Discard
// buttons fire `onKeepBoth` / `onDiscard` with the copy's note id. Pure
// component — no IPC.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ConflictsView } from "../../src/notes/components/ConflictsView";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";

afterEach(cleanup);

// A conflict-copy record. Mirrors the `TitleRecord` shape (`loadNoteBatch.ts`)
// with the conflict markers populated — `conflict: true` + `conflict_of:` set
// to the original the copy forked from. Only `noteUuid` / `title` /
// `conflictOf` are load-bearing for the view; the rest carry the calm defaults.
function copy(
  noteUuid: string,
  title: string | null,
  conflictOf: string,
): TitleRecord {
  return {
    noteUuid,
    title,
    folder: null,
    updatedAt: null,
    trashed: null,
    deleted: null,
    archived: null,
    template: false,
    folderIndex: false,
    conflict: true,
    conflictOf,
  };
}

// Build a grouped conflict set keyed by original UUID — the
// `conflictRecordsByOriginal` shape the view consumes.
function groupsOf(
  entries: Array<[string, TitleRecord[]]>,
): Map<string, TitleRecord[]> {
  return new Map(entries);
}

const ORIG_A = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const ORIG_B = "ffeeddccbbaa00998877665544332211";

describe("ConflictsView — empty state", () => {
  it("renders the calm empty state (no view, no group) for zero groups", () => {
    render(
      <ConflictsView groups={groupsOf([])} onKeepBoth={vi.fn()} onDiscard={vi.fn()} onTakeTheirs={vi.fn()} />,
    );
    expect(screen.getByTestId("conflicts.empty").textContent).toContain(
      "No conflicts",
    );
    expect(screen.queryByTestId("conflicts.view")).toBeNull();
    expect(screen.queryByTestId("conflicts.group")).toBeNull();
    expect(screen.queryByTestId("conflicts.copy")).toBeNull();
  });
});

describe("ConflictsView — group + copy rendering", () => {
  it("renders the view container with one group per Map entry", () => {
    const groups = groupsOf([
      [ORIG_A, [copy("c1", "Alpha", ORIG_A)]],
      [ORIG_B, [copy("c2", "Beta", ORIG_B)]],
    ]);
    render(
      <ConflictsView groups={groups} onKeepBoth={vi.fn()} onDiscard={vi.fn()} onTakeTheirs={vi.fn()} />,
    );
    expect(screen.getByTestId("conflicts.view")).toBeTruthy();
    expect(screen.queryByTestId("conflicts.empty")).toBeNull();
    const groupEls = screen.getAllByTestId("conflicts.group");
    expect(groupEls).toHaveLength(2);
    // Each group is tagged with the original UUID it forked from.
    expect(groupEls.map((g) => g.getAttribute("data-conflict-of"))).toEqual([
      ORIG_A,
      ORIG_B,
    ]);
  });

  it("renders one copy row per record, tagged with its note id", () => {
    const groups = groupsOf([
      [ORIG_A, [copy("c1", "Alpha", ORIG_A), copy("c2", "Bravo", ORIG_A)]],
    ]);
    render(
      <ConflictsView groups={groups} onKeepBoth={vi.fn()} onDiscard={vi.fn()} onTakeTheirs={vi.fn()} />,
    );
    const rows = screen.getAllByTestId("conflicts.copy");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.getAttribute("data-note-id"))).toEqual([
      "c1",
      "c2",
    ]);
    expect(rows[0]!.textContent).toContain("Alpha");
    expect(rows[1]!.textContent).toContain("Bravo");
  });

  it("falls back to an 'Untitled (<uuid prefix>)' label for a null title", () => {
    const groups = groupsOf([
      ["aabbccddeeff00112233445566778899", [
        copy("deadbeefcafef00d0011223344556677", null, "aabbccddeeff00112233445566778899"),
      ]],
    ]);
    render(
      <ConflictsView groups={groups} onKeepBoth={vi.fn()} onDiscard={vi.fn()} onTakeTheirs={vi.fn()} />,
    );
    const row = screen.getByTestId("conflicts.copy");
    expect(row.textContent).toContain("Untitled");
    // The displayed prefix is the copy's own uuid, not the original.
    expect(row.textContent).toContain("deadbe");
  });

  it("uses a pluralized group heading reflecting the copy count + original prefix", () => {
    const groups = groupsOf([
      [ORIG_A, [copy("c1", "Alpha", ORIG_A)]],
      [ORIG_B, [copy("c2", "Beta", ORIG_B), copy("c3", "Gamma", ORIG_B)]],
    ]);
    render(
      <ConflictsView groups={groups} onKeepBoth={vi.fn()} onDiscard={vi.fn()} onTakeTheirs={vi.fn()} />,
    );
    const [groupA, groupB] = screen.getAllByTestId("conflicts.group");
    expect(groupA!.textContent).toContain("1 conflicting copy");
    expect(groupA!.textContent).toContain(ORIG_A.slice(0, 8));
    expect(groupB!.textContent).toContain("2 conflicting copies");
    expect(groupB!.textContent).toContain(ORIG_B.slice(0, 8));
  });
});

describe("ConflictsView — reconcile actions", () => {
  it("clicking Keep-as-separate fires onKeepBoth with the copy's note id", () => {
    const onKeepBoth = vi.fn();
    const onDiscard = vi.fn();
    const groups = groupsOf([[ORIG_A, [copy("c1", "Alpha", ORIG_A)]]]);
    render(
      <ConflictsView
        groups={groups}
        onKeepBoth={onKeepBoth}
        onDiscard={onDiscard}
        onTakeTheirs={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("conflicts.keep-both"));
    expect(onKeepBoth).toHaveBeenCalledWith("c1");
    expect(onKeepBoth).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("clicking Discard fires onDiscard with the copy's note id", () => {
    const onKeepBoth = vi.fn();
    const onDiscard = vi.fn();
    const groups = groupsOf([[ORIG_A, [copy("c1", "Alpha", ORIG_A)]]]);
    render(
      <ConflictsView
        groups={groups}
        onKeepBoth={onKeepBoth}
        onDiscard={onDiscard}
        onTakeTheirs={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("conflicts.discard"));
    expect(onDiscard).toHaveBeenCalledWith("c1");
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onKeepBoth).not.toHaveBeenCalled();
  });

  it("routes each row's buttons to that row's own note id (no cross-talk)", () => {
    const onKeepBoth = vi.fn();
    const onDiscard = vi.fn();
    const groups = groupsOf([
      [ORIG_A, [copy("c1", "Alpha", ORIG_A)]],
      [ORIG_B, [copy("c2", "Beta", ORIG_B), copy("c3", "Gamma", ORIG_B)]],
    ]);
    render(
      <ConflictsView
        groups={groups}
        onKeepBoth={onKeepBoth}
        onDiscard={onDiscard}
        onTakeTheirs={vi.fn()}
      />,
    );
    const rowByNote = (id: string) =>
      screen
        .getAllByTestId("conflicts.copy")
        .find((r) => r.getAttribute("data-note-id") === id)!;

    fireEvent.click(within(rowByNote("c3")).getByTestId("conflicts.keep-both"));
    expect(onKeepBoth).toHaveBeenCalledWith("c3");

    fireEvent.click(within(rowByNote("c2")).getByTestId("conflicts.discard"));
    expect(onDiscard).toHaveBeenCalledWith("c2");

    fireEvent.click(within(rowByNote("c1")).getByTestId("conflicts.keep-both"));
    expect(onKeepBoth).toHaveBeenLastCalledWith("c1");
  });
});

describe("ConflictsView — take theirs (Use this version)", () => {
  it("clicking 'Use this version' fires onTakeTheirs with the copy id + original uuid", () => {
    const onTakeTheirs = vi.fn();
    const groups = groupsOf([[ORIG_A, [copy("c1", "Alpha", ORIG_A)]]]);
    render(
      <ConflictsView
        groups={groups}
        onKeepBoth={vi.fn()}
        onDiscard={vi.fn()}
        onTakeTheirs={onTakeTheirs}
      />,
    );
    fireEvent.click(screen.getByTestId("conflicts.take-this"));
    expect(onTakeTheirs).toHaveBeenCalledWith("c1", ORIG_A);
    expect(onTakeTheirs).toHaveBeenCalledTimes(1);
  });

  it("renders the three actions in order: Keep-as-separate · Discard · Use this version (rightmost)", () => {
    const groups = groupsOf([[ORIG_A, [copy("c1", "Alpha", ORIG_A)]]]);
    render(
      <ConflictsView
        groups={groups}
        onKeepBoth={vi.fn()}
        onDiscard={vi.fn()}
        onTakeTheirs={vi.fn()}
      />,
    );
    const row = screen.getByTestId("conflicts.copy");
    const testIds = within(row)
      .getAllByRole("button")
      .map((b) => b.getAttribute("data-testid"));
    expect(testIds).toEqual([
      "conflicts.keep-both",
      "conflicts.discard",
      "conflicts.take-this",
    ]);
  });

  it("suppresses the Use-this-version button for an unknown-original group", () => {
    // Orphan copy (no `conflict_of:`) groups under the "(unknown)" sentinel —
    // there is no original to trash, so take-theirs is not offered (Keep-as-
    // separate / Discard still are).
    const groups = groupsOf([["(unknown)", [copy("c1", "Orphan", "(unknown)")]]]);
    render(
      <ConflictsView
        groups={groups}
        onKeepBoth={vi.fn()}
        onDiscard={vi.fn()}
        onTakeTheirs={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("conflicts.take-this")).toBeNull();
    expect(screen.getByTestId("conflicts.keep-both")).toBeTruthy();
    expect(screen.getByTestId("conflicts.discard")).toBeTruthy();
  });

  it("routes each row's Use-this-version to that row's own ids (no cross-talk)", () => {
    const onTakeTheirs = vi.fn();
    const groups = groupsOf([
      [ORIG_A, [copy("c1", "Alpha", ORIG_A)]],
      [ORIG_B, [copy("c2", "Beta", ORIG_B), copy("c3", "Gamma", ORIG_B)]],
    ]);
    render(
      <ConflictsView
        groups={groups}
        onKeepBoth={vi.fn()}
        onDiscard={vi.fn()}
        onTakeTheirs={onTakeTheirs}
      />,
    );
    const rowByNote = (id: string) =>
      screen
        .getAllByTestId("conflicts.copy")
        .find((r) => r.getAttribute("data-note-id") === id)!;
    fireEvent.click(within(rowByNote("c3")).getByTestId("conflicts.take-this"));
    expect(onTakeTheirs).toHaveBeenLastCalledWith("c3", ORIG_B);
    fireEvent.click(within(rowByNote("c1")).getByTestId("conflicts.take-this"));
    expect(onTakeTheirs).toHaveBeenLastCalledWith("c1", ORIG_A);
  });
});
