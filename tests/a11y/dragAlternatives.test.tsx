// @vitest-environment jsdom
//
// A non-drag path for every drag (myne-md/myne#728, task 12; WCAG 2.5.7).
//
// The criterion is that any function operated by a DRAG can also be operated
// by a single pointer without one.
//
// This file first stated its denominator as a fact - "the audit found three
// surfaces in scope" - and the tree contradicted it. Review found two more
// drag-operated functions with no non-drag path that appear nowhere in that
// list: colour-group reorder (where order IS precedence) and Favorites
// reorder. Both are now fixed, and the hand list is replaced by a SCAN with a
// verdict per file, compared both ways, which is the shape every sibling
// audit in this pass already uses (`focusNotObscured`, `redundantEntryAndHelp`,
// the mobile `tappable` sweep). A hand list cannot see the surface it already
// missed, and it certainly cannot see the next one.
//
//   - move a note to a folder: already a palette action (`note.move`) and a
//     sidebar context-menu item. No gap.
//   - move a FOLDER: already a "Move folder to…" context submenu. No gap.
//   - note cover PLACEMENT: there is no drag. The banner is a fixed-height
//     crop from the centre with no per-note focal point, by design
//     (`--cover-banner-h`, myne-md/myne#410), so there is no drag-operated
//     function to provide an alternative for.
//   - reorder a TAB: drag and nothing else. This is the gap, and the fix.
//
// The graph is out of scope; its accessibility ships with myne-md/myne#727.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TabStrip } from "../../src/notes/components/TabStrip";

afterEach(cleanup);

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function strip(activeTab = "B") {
  const onMoveTab = vi.fn();
  render(
    <TabStrip
      paneId="pane-1"
      tabs={["A", "B", "C"]}
      activeTab={activeTab}
      titleOf={(id) => `Note ${id}`}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onNewTab={vi.fn()}
      onMoveTab={onMoveTab}
      onTogglePin={vi.fn()}
      isPinned={() => false}
    />,
  );
  return { onMoveTab };
}

/** Open the context menu on the tab whose `data-tab-id` is `id`. */
function openTabMenu(id: string): void {
  const tab = screen
    .getAllByRole("tab")
    .find((el) => el.getAttribute("data-tab-id") === id);
  expect(tab, `tab ${id}`).toBeDefined();
  fireEvent.contextMenu(tab as HTMLElement, { clientX: 10, clientY: 10 });
}

function menuItem(label: string): HTMLElement {
  return screen.getByRole("menuitem", { name: label });
}

describe("a tab can be reordered without a drag", () => {
  it("offers both directions on a middle tab", () => {
    strip();
    openTabMenu("B");
    expect(menuItem("Move left")).toBeTruthy();
    expect(menuItem("Move right")).toBeTruthy();
  });

  it("moves left to the slot before it", () => {
    const { onMoveTab } = strip();
    openTabMenu("B");
    fireEvent.click(menuItem("Move left"));
    expect(onMoveTab).toHaveBeenCalledWith("pane-1", "B", 0);
  });

  it("moves right by ONE slot, in post-removal terms", () => {
    // The contract the drop handler uses: the tab is removed before it is
    // re-inserted, so one place right is `index + 1`, not `index + 2`. Getting
    // this wrong moves the tab two places and reads as a different bug.
    const { onMoveTab } = strip();
    openTabMenu("B");
    fireEvent.click(menuItem("Move right"));
    expect(onMoveTab).toHaveBeenCalledWith("pane-1", "B", 2);
  });

  it("offers only the direction an end tab can go", () => {
    // A disabled row would invite the question "why not?", and there is no
    // interesting answer for the first tab not moving left.
    strip("A");
    openTabMenu("A");
    expect(screen.queryByRole("menuitem", { name: "Move left" })).toBeNull();
    expect(menuItem("Move right")).toBeTruthy();
    cleanup();
    strip("C");
    openTabMenu("C");
    expect(menuItem("Move left")).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Move right" })).toBeNull();
  });

  it("keeps Pin reachable beside the new rows", () => {
    strip();
    openTabMenu("B");
    expect(menuItem("Pin")).toBeTruthy();
  });
});

describe("the surfaces that already had an alternative", () => {
  it("a note can be moved to a folder from the palette", () => {
    const actions = code("src/commands/actions.ts");
    expect(actions).toContain('notesAction("note.move"');
  });

  it("a folder can be moved from its context menu", () => {
    const list = code("src/notes/components/NoteList.tsx");
    expect(list).toContain("notes.list.moveFolderTo");
    expect(list).toContain("fm.moveFolderTo(node, null)");
  });

  it("the note cover has no placement drag to provide an alternative for", () => {
    // Fixed-height crop from the centre, no per-note focal point. If a focal
    // point is ever added as a drag, this assertion is what should fail.
    const cover = code("editor/src/decorations/cover-banner.ts");
    expect(cover).not.toContain("draggable");
    expect(cover).not.toContain("objectPosition");
  });
});


/**
 * The DENOMINATOR, scanned rather than asserted.
 *
 * Every file carrying `draggable` owes a verdict: either the drag-operated
 * function has a non-drag path in the same file (a key handler), or it is
 * recorded here with the reason it needs none. Compared both ways, so a
 * verdict cannot outlive its file.
 */
const NO_ALTERNATIVE_NEEDED: Record<string, string> = {
  "src/notes/components/FolderRow.tsx":
    "Moving a folder is drag OR the 'Move folder to…' context submenu, which " +
    "is the alternative; the row itself carries no other drag-operated function.",
  "src/notes/components/PaneTree.tsx":
    "Pane split resize. A pointer-drag on a splitter is exempt under 2.5.7's " +
    "own carve-out for a path-independent single-pointer gesture, and the " +
    "layout it adjusts is reachable by the split and close commands.",
  "src/screens/Editor.tsx":
    "Right-panel resize, the same splitter case as PaneTree, plus the panel's " +
    "own show/hide commands.",
  "editor/src/attachments/lightbox.ts":
    "Pan of a zoomed image inside the lightbox. The FUNCTION is viewing the " +
    "image, which zoom-to-fit and the keyboard close already provide; the pan " +
    "adjusts a view rather than performing an operation.",
  "editor/src/decorations/table.ts":
    "Column-width drag. Cosmetic sizing of a rendered table, not a function " +
    "that changes the document; the table's content is reachable regardless.",
  "src/notes/components/LeftRibbon.tsx":
    "The rail itself. Its reorder IS the Alt+Arrow contract the other rosters " +
    "borrow, implemented in `RibbonCustomizeSettings` over the same order.",
  "src/components/settings/ToolbarCustomizeSettings.tsx":
    "Already has the BEST alternative rather than none: explicit 'Move up' / " +
    "'Move down' buttons per row, each a named control calling the same " +
    "`move(id, delta)` the drag ends in. The scan flagged it because the " +
    "predicate looks for a key handler, and a visible button is a stronger " +
    "answer to 2.5.7 than a key contract a user has to know about.",
  "src/notes/components/NoteList.tsx":
    "Two drags: note/folder move (palette `note.move` plus the context menu) " +
    "and Favorites reorder, which gained its Alt+Arrow path in this change.",
};

describe("every drag-operated surface has a non-drag path", () => {
  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full: string = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...tsFiles(full));
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  const roots = ["src", "editor/src", "mobile/src", "web/src"].filter((r) => {
    try {
      return statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
  const sites = roots
    .flatMap(tsFiles)
    .filter((f) => /\bdraggable\b/.test(readFileSync(f, "utf8")));

  it("finds the draggable surfaces at all", () => {
    // Non-vacuity: a scan that stops matching reports a clean tree.
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it("each one has a key handler, or a recorded reason it needs none", () => {
    // The predicate is deliberately crude (does the file handle a key at
    // all) and the reason table carries the judgement. A cleverer predicate
    // would have to decide what counts as an alternative, which is the
    // question a human should answer per surface and write down.
    const bare = sites.filter(
      (f) => !readFileSync(f, "utf8").includes("onKeyDown") && !(f in NO_ALTERNATIVE_NEEDED),
    );
    expect(
      bare,
      `Drag-operated with no keyboard path and no recorded reason (WCAG 2.5.7). Add the Alt+Arrow contract the rail uses, or record the file with the reason it needs no alternative.\n${bare.join("\n")}`,
    ).toEqual([]);
  });

  it("a recorded reason does not outlive its file", () => {
    const stale = Object.keys(NO_ALTERNATIVE_NEEDED).filter((f) => !sites.includes(f));
    expect(
      stale,
      `Recorded as needing no alternative but no longer draggable. Drop the entry.\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("the two surfaces review found are wired, at their call sites", () => {
    // The scan above is satisfied by ANY `onKeyDown` in a file, and both of
    // these files have an unrelated one (the colour-group name input's
    // Enter), so the scan cannot see these two regress. That was measured
    // rather than assumed: deleting the colour-group handler and renaming
    // its declaration left the scan green.
    //
    // So these assert the CALL SITE rather than a name. A first version
    // matched the bare identifier `onRowKeyDown` and stayed green through
    // the same injection, because a comment in the file mentions
    // `RibbonCustomizeSettings.onRowKeyDown` - the string survived the
    // deletion of the thing it named.
    expect(
      readFileSync("src/notes/components/ColorGroupEditor.tsx", "utf8"),
      "the colour-group row must bind the Alt+Arrow handler",
    ).toContain("onKeyDown={(e) => onRowKeyDown(e, rule.id)}");
    expect(
      readFileSync("src/notes/components/NoteList.tsx", "utf8"),
      "the favourites row must call the keyboard move",
    ).toContain("fm.moveFavorite(id,");
    expect(
      readFileSync("src/notes/components/useFolderManagement.ts", "utf8"),
      "the manager must expose it",
    ).toContain("const moveFavorite = useCallback(");
  });
});
