// myne-md/myne#655, deleting a note could start an unstoppable flash, with the
// active note swapping between two notes forever, exit only by killing the app.
//
// The cause is the pair of selection bridges in `Editor.tsx`, which their own
// comment describes as "two one-way syncs that never loop". They are, for a
// note that is alive. A delete breaks that premise for a moment: the cache row
// is dropped optimistically, while the tab is removed from every pane by a
// separate `setState`. In the gap, the focused pane's active tab is still the
// dead note, so bridge B mirrors the dead id into `selectedId`, bridge A finds
// it open in no pane and re-opens it into the focused pane, which makes it the
// active tab again. Each hand-off remounts the pane, which is the flashing.
//
// Both bridges now check the sidebar cache, which is the liveness roster the
// tree already renders from. Either check alone breaks the cycle; both are there
// because each is the right rule for its own direction.

import { describe, expect, it } from "vitest";
import {
  EMPTY_SIDEBAR_STATE,
  applyOptimisticCreate,
  applyOptimisticDelete,
  type SidebarState,
} from "../../src/notes/sidebarState";
import {
  shouldMirrorSelection,
  shouldOpenIntoFocusedPane,
} from "../../src/notes/selectionBridges";

describe("neither selection bridge acts on a note that no longer exists", () => {
  const DEAD = "dead-note";
  const LIVE = "live-note";

  /**
   * Drive the two REAL predicates against a tiny world for N rounds.
   *
   * The first version of this file re-implemented both rules inside the test,
   * which detects a change to the model and not to the app: deleting both
   * guards from `Editor.tsx` left every case green. These are the functions
   * `Editor.tsx` imports.
   */
  function run(cache: ReadonlySet<string>, rounds = 20) {
    let activeTab: string | null = DEAD;
    let selectedId: string | null = null;
    const openAnywhere = new Set<string>();
    let opens = 0;

    for (let i = 0; i < rounds; i++) {
      const tabLive = activeTab === null || cache.has(activeTab);
      if (shouldMirrorSelection(activeTab, tabLive)) selectedId = activeTab;
      const selLive = selectedId !== null && cache.has(selectedId);
      const alreadyOpen = selectedId !== null && openAnywhere.has(selectedId);
      if (shouldOpenIntoFocusedPane(selectedId, selLive, alreadyOpen)) {
        opens += 1;
        openAnywhere.add(selectedId!);
        activeTab = selectedId; // opening makes it the focused pane's active tab
      }
    }
    return { selectedId, opens };
  }

  it("the pair terminates on a note the cache has dropped", () => {
    // The reported loop. The tab removal has not landed yet, so the focused
    // pane's active tab is still the deleted note while its cache row is gone.
    const out = run(new Set([LIVE]));
    expect(out.selectedId).toBeNull();
    expect(out.opens).toBe(0);
  });

  it("a live note flows through both bridges exactly once", () => {
    // The other direction, and the reason the loop counts opens rather than
    // asserting a boolean: a live note must be opened once and not re-opened.
    const out = run(new Set([LIVE, DEAD]));
    expect(out.selectedId).toBe(DEAD);
    expect(out.opens).toBe(1);
  });

  it("mirroring null is always allowed, so a cleared selection propagates", () => {
    expect(shouldMirrorSelection(null, false)).toBe(true);
  });

  it("an already-open live note is not re-opened", () => {
    expect(shouldOpenIntoFocusedPane(LIVE, true, true)).toBe(false);
  });

  it("a dead note is refused by BOTH rules, not just one", () => {
    // Either check alone breaks the cycle, so asserting only one would still
    // pass with the other deleted.
    expect(shouldMirrorSelection(DEAD, false)).toBe(false);
    expect(shouldOpenIntoFocusedPane(DEAD, false, false)).toBe(false);
  });
});

describe("an optimistic delete leaves no dangling references", () => {
  const ID = "00000199-0000-7000-8000-00000000000a";

  function withCreated(): SidebarState {
    const seeded = applyOptimisticCreate(EMPTY_SIDEBAR_STATE, ID);
    return { ...seeded, selectedId: ID, justCreatedId: ID, renamingId: ID };
  }

  it("drops the row from the cache, which is what both bridges read", () => {
    const { next } = applyOptimisticDelete(withCreated(), ID);
    expect(next.cache.has(ID)).toBe(false);
  });

  it("clears the selection, the rename and the new-note pin", () => {
    const { next } = applyOptimisticDelete(withCreated(), ID);
    expect(next.selectedId).toBeNull();
    expect(next.renamingId).toBeNull();
    // myne#654's pin. Harmless to the ordering on its own, nothing matches a
    // key that is not among the children, but a dangling id is what becomes a
    // real bug the next time somebody reads it for something else.
    expect(next.justCreatedId).toBeNull();
  });

  it("leaves another note's pin and selection alone", () => {
    const other = "00000199-0000-7000-8000-00000000000b";
    const state: SidebarState = {
      ...applyOptimisticCreate(applyOptimisticCreate(EMPTY_SIDEBAR_STATE, other), ID),
      selectedId: other,
      justCreatedId: other,
    };
    const { next } = applyOptimisticDelete(state, ID);
    expect(next.selectedId).toBe(other);
    expect(next.justCreatedId).toBe(other);
  });
});
