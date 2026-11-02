// `<NoteList>` — Notes sidebar container.
//
// Visual canon: Penpot frames `screen------notes-sidebar--empty` (boş
// vault) + `screen------notes-sidebar--populated` (Notes header +
// "+ New Note" button + virtualized rows). Tokens per
// `colors_and_type.css`.
//
// PRD stories: 1 (empty state placeholder), 2 (sidebar populates after
// unlock), 78 (container), 81 (empty CTA).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { viewsEnabled, VIEWS_ENABLED_EVENT } from "../../lib/viewsEnabled";
import { orderSavedViews } from "../views/orderSavedViews";
import { isViewApproved } from "../views/viewApproval";
import { saveLocalViewEdit } from "../views/saveViewEdit";
import { canExportViewManifest, exportViewManifest } from "../exportViewManifest";
import { VISUALLY_HIDDEN } from "../../components/primitives/visuallyHidden";
import { SECTION_HEADING_STYLE } from "./sharedStyles";
import { SidebarSearchRow } from "./SidebarSearchRow";
import { flushBeforeFrontmatterWrite } from "../flushBeforeFrontmatterWrite";
import { settleFrontmatterWrite } from "../settleFrontmatterWrite";
import { noteRead } from "../readNote";
import {
  liveCache,
  useSelectedNote,
  type NoteId,
  type UseSelectedNoteReturn,
} from "../sidebarState";
import { archivedFolderKeys } from "../archivedFolders";
import { ArchivePanel } from "./ArchivePanel";
import { TrashPanel } from "./TrashPanel";
import { sidebarCommands } from "../sidebarCommands";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { deriveFolderTree, type FolderNode } from "../folderTree";
import {
  ancestorPaths,
  foldSegment,
  folderKey,
  normalizeFolderPath,
} from "../../dialect/folderPath";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import type { NoteExportUiHooks } from "../exportFlow";
import { noteExportEntries } from "../noteExportMenu";
import { DecorationPopover } from "./DecorationPopover";
import { Toast } from "../../components/Toast";
import { FolderRow } from "./FolderRow";
import { NoteRow, noteRowDomId, type NoteRowSection } from "./NoteRow";
import { TreeRails } from "./TreeRails";
import { importDroppedMarkdown } from "../dropImport";
import { BASE_PADDING_LEFT as TREE_BASE_PADDING_LEFT } from "./FolderRow";
import {
  createFolderNote,
  setFolderIndex,
  unsetFolderIndex,
} from "../folderNote";
import type { TitleRecord } from "../loadNoteBatch";
import { VirtualList } from "./VirtualList";
import { Button } from "../../components/primitives/Button";
import { EmptyState as ZeroState } from "../../components/primitives/EmptyState";
import { tabKindSpec } from "../tabKinds";
import { isPanesNotSettled, panesNotSettledMessage, useWorkspace } from "../workspaceContext";
import { IconButton } from "../../components/primitives/IconButton";
import { ViewsSection } from "./ViewsSection";
import { FilterBuilder, type FolderOption } from "./FilterBuilder";
import { ViewSettings, type ViewDisplayPatch } from "./ViewSettings";
import { vaultIndicesPropertyKeys } from "../vaultIndices";
import {
  draftToFilterNode,
  filterNodeToDraft,
  type FilterDraft,
} from "../filterDraft";
import { usePrefs } from "../../hooks/usePrefs";
import {
  deleteSavedView,
  setViewOrder,
  upsertSavedView,
  type SavedView,
} from "../../lib/prefs";
import { moveInOrder } from "../reorderViewOrder";
import {
  buildFavoriteRows,
  flattenVisibleRows,
  visibleNoteIds,
  type VisibleRow,
} from "./folderTreeRows";
import { dragEdge, insertionLineStyle } from "./reorderDnd";
import {
  useFolderManagement,
  type FolderManagement,
} from "./useFolderManagement";
import { regionOf } from "../../lib/regions";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useUnsyncedEdits } from "../../hooks/useUnsyncedEdits";

/**
 * Compute the adjacent note to select after deleting `victimId` from
 * `sortedIds`. Picks the next row in sort order, falling back to the
 * previous row, falling back to `null` (empty list).
 *
 * Exported for unit tests (`triggerHandlers.test.ts`).
 */
export function pickAdjacentAfterDelete(
  sortedIds: readonly NoteId[],
  victimId: NoteId,
): NoteId | null {
  const idx = sortedIds.indexOf(victimId);
  if (idx === -1) return null;
  const next = sortedIds[idx + 1];
  if (next !== undefined) return next;
  const prev = sortedIds[idx - 1];
  if (prev !== undefined) return prev;
  return null;
}

/**
 * Document-level F2 keyboard handler — global keymap for "enter inline-
 * rename on the currently-selected sidebar row". Fires only when:
 *
 * - `selectedId !== null` (there's a row to rename).
 * - `renamingId === null` (not already in rename mode; F2-while-renaming
 *   would no-op since the input is already focused).
 *
 * Returning the inner handler from a factory keeps it directly unit-
 * testable (`tests/notes/triggerHandlers.test.ts`).
 */
export function makeF2KeydownHandler(
  ctx: Pick<UseSelectedNoteReturn, "selectedId" | "renamingId" | "startRename">,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    if (e.key !== "F2") return;
    // A modal dialog (e.g. the keyboard-delete confirm gate) owns the keyboard
    // while open — don't start an inline rename underneath it. `typeof document`
    // keeps the handler node-testable (triggerHandlers.test.ts has no DOM).
    if (typeof document !== "undefined" && document.querySelector('[role="alertdialog"]') !== null) {
      return;
    }
    if (ctx.selectedId === null) return;
    if (ctx.renamingId !== null) return;
    e.preventDefault();
    ctx.startRename(ctx.selectedId);
  };
}

/**
 * Keyboard navigation handler factory for the sidebar — covers PRD
 * stories 12-17 (↑/↓ selection move, Enter open, Home/End jump,
 * PgUp/PgDn viewport jump, Esc unfocus).
 *
 * The factory takes the current sorted-IDs array and the context's
 * selection + open/select callbacks, and returns a single keydown
 * handler bound at document level. The `pageSize` parameter is the
 * approximate visible-row count used for Page Up/Down jumps (defaults
 * to 10 — close to a 4K-sized viewport's row capacity).
 *
 * Skips events originating inside editable targets (input / textarea /
 * contenteditable) so the editor body doesn't receive sidebar nav.
 */
export function makeKeyboardNavHandler(opts: {
  sortedIds: readonly NoteId[];
  selectedId: NoteId | null;
  renamingId: NoteId | null;
  select: (id: NoteId | null) => void;
  open: (id: NoteId) => Promise<unknown>;
  pageSize?: number;
  /** Collapse the multi-selection (MYND-367) — cursor-moving keys and Escape
   *  drop the set, mirroring Finder. Optional so isolated callers can omit it. */
  clearMultiSelection?: () => void;
}): (e: KeyboardEvent) => void {
  const {
    sortedIds,
    selectedId,
    renamingId,
    select,
    open,
    pageSize = 10,
    clearMultiSelection,
  } = opts;
  // Cursor-moving keys collapse any multi-selection before they move the
  // single cursor — arrow-nav after a multi-select returns to single mode.
  const moveSelect = (id: NoteId | null): void => {
    clearMultiSelection?.();
    select(id);
  };

  const isEditableTarget = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    if (el === null) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    return false;
  };

  /**
   * Whether the sidebar's arrow keys apply to this event (myne-md/myne#728).
   *
   * This handler is bound at DOCUMENT level, so before the region model it
   * answered arrows anywhere that was not an editable target: an arrow press
   * inside the right panel moved the note selection behind the user's back.
   * With F6 able to put focus in a named region, "which region am I in" is now
   * a question with an answer, so the handler asks it.
   *
   * The `null` region is deliberately allowed, and it is the common case rather
   * than an edge: nothing is focused (`document.body`) right after a click on a
   * note row, and that is exactly when a user reaches for the arrows. Refusing
   * it would take away behaviour that works today, which is not what scoping is
   * for.
   */
  const appliesToRegion = (target: EventTarget | null): boolean => {
    const region = regionOf(target instanceof Element ? target : null);
    return region === null || region === "sidebar";
  };

  return (e: KeyboardEvent) => {
    if (renamingId !== null) return; // rename mode owns keys
    // A modal dialog (role="alertdialog", e.g. the keyboard-delete confirm gate)
    // owns the keyboard while open: its own Enter/Escape handlers must win, and
    // background list nav (arrows / Enter-open) must not run underneath it.
    // Without this bail-out the nav handler's `case "Enter"` preventDefault()s
    // the event and opens the selected note, swallowing the modal's confirm-on-
    // Enter (Escape was unaffected because nav ignores it) — the MYND-487 E2E
    // regression. `typeof document` keeps the factory node-testable.
    if (typeof document !== "undefined" && document.querySelector('[role="alertdialog"]') !== null) {
      return;
    }
    if (isEditableTarget(e.target)) return;
    if (!appliesToRegion(e.target)) return;
    if (sortedIds.length === 0) return;
    const idx = selectedId === null ? -1 : sortedIds.indexOf(selectedId);

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next = idx < 0 ? 0 : Math.min(idx + 1, sortedIds.length - 1);
        moveSelect(sortedIds[next] ?? null);
        return;
      }
      case "ArrowUp": {
        e.preventDefault();
        const next = idx <= 0 ? 0 : idx - 1;
        moveSelect(sortedIds[next] ?? null);
        return;
      }
      case "Home": {
        e.preventDefault();
        moveSelect(sortedIds[0] ?? null);
        return;
      }
      case "End": {
        e.preventDefault();
        moveSelect(sortedIds[sortedIds.length - 1] ?? null);
        return;
      }
      case "PageDown": {
        e.preventDefault();
        const target = Math.min(
          idx < 0 ? pageSize - 1 : idx + pageSize,
          sortedIds.length - 1,
        );
        moveSelect(sortedIds[target] ?? null);
        return;
      }
      case "PageUp": {
        e.preventDefault();
        const target = idx < 0 ? 0 : Math.max(idx - pageSize, 0);
        moveSelect(sortedIds[target] ?? null);
        return;
      }
      case "Enter": {
        if (selectedId !== null) {
          e.preventDefault();
          void open(selectedId);
        }
        return;
      }
      case "Escape": {
        // Drop a multi-selection (MYND-367); leave `selectedId` so the editor
        // keeps the open note. No-op when nothing is multi-selected.
        clearMultiSelection?.();
        return;
      }
      default:
        return;
    }
  };
}

/**
 * Whether a ROW inside `ref` currently holds the group's Tab stop.
 *
 * Exported so `tests/a11y/noteListTabStops.test.tsx` drives THIS function
 * rather than a copy of it. A private version was written first and the test
 * reimplemented the same effect in its own harness, which is a fixture that
 * cannot hold the defect: reverting the fix here would have left that test
 * green, because it was never reading this code.
 *
 * Driven by a MutationObserver rather than by the caller's render cadence, and
 * the review of this pass is why. A bare `useEffect` with no dependency array
 * runs when the CALLER renders; the rows are mounted by `VirtualList`, which
 * re-renders on scroll from its own internal state without re-rendering the
 * caller. So an ordinary scroll that pushed the stop-holding row out of the
 * window left this `true` over a tree with no `tabindex="0"` in it, the
 * container kept `tabIndex={-1}` believing a row had the stop, and the whole
 * sidebar had no Tab stop at all. Both directions matter: the mirror case
 * leaves the container AND a row at `0`, which is two stops for one group.
 *
 * `attributeFilter: ["tabindex"]` is the third case and neither of the others
 * covers it: the stop can move between two rows that both stay mounted.
 */
export function useRowOwnsTabStop(ref: RefObject<HTMLElement | null>): boolean {
  const [owns, setOwns] = useState(false);
  useEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const measure = (): void => {
      const has = root.querySelector('[role="treeitem"][tabindex="0"]') !== null;
      setOwns((prev) => (prev === has ? prev : has));
    };
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["tabindex"],
    });
    return () => observer.disconnect();
  }, [ref]);
  return owns;
}

/**
 * The sidebar tree's own keyboard handler (myne-md/myne#728, task 7).
 *
 * `makeKeyboardNavHandler` above is bound at DOCUMENT level and answers arrows
 * while nothing in particular is focused, which is the state after clicking a
 * row. It moves the note SELECTION over the note ids, and it cannot do more
 * than that: folder rows are not notes, so it has never been able to reach
 * one, which is why a keyboard user could not expand or collapse a folder at
 * all.
 *
 * This one is bound on the tree CONTAINER and takes over whenever focus is on
 * a row inside it, which is the WAI-ARIA tree pattern: Up/Down walk the rows
 * (folders included), Left/Right collapse and expand a folder, Enter and Space
 * activate. It calls `stopPropagation` on every key it handles, so the
 * document handler stands down rather than the two both acting on one press.
 *
 * Landing on a NOTE row also selects it, so the behaviour a keyboard user
 * already had is preserved rather than replaced: what changes is that folder
 * rows are now stops on the same walk instead of being skipped.
 *
 * Home/End/PageUp/PageDown are deliberately NOT handled here and bubble to the
 * document handler. It ranges over the whole note list, while this one can
 * only see the rows the virtualizer has mounted, so its answer to "go to the
 * end" is right and this one's would be "the end of the window".
 *
 * Taking a `rowsOf` reader rather than an element keeps it testable against a
 * fabricated row list, and keeps the virtualized-window question in one place.
 */
export function makeTreeKeydownHandler(opts: {
  /** The rendered `role="treeitem"` elements, in DOM order. */
  rowsOf: () => readonly HTMLElement[];
  /** Move the note selection (and, through the caller, the open note). */
  select: (id: NoteId) => void;
  /** Open the note under the cursor (Enter / Space on a note row). */
  open: (id: NoteId) => void;
  /** Collapse or expand a folder, by the folder's `node.key`. */
  toggleFolder: (key: string) => void;
  /** True while an inline rename owns the keyboard. */
  renaming: boolean;
}): (e: {
  key: string;
  target: EventTarget | null;
  preventDefault: () => void;
  stopPropagation: () => void;
}) => void {
  const { rowsOf, select, open, toggleFolder, renaming } = opts;

  const focusRow = (row: HTMLElement | undefined): void => {
    if (row === undefined) return;
    row.focus();
    const noteId = row.getAttribute("data-note-id");
    // A folder row is a focus stop only; a note row is also a selection, which
    // is what keeps the arrows doing what they already did.
    if (noteId !== null) select(noteId);
  };

  return (e) => {
    if (renaming) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target === null) return;
    // The inline rename input lives INSIDE a row, so `closest` would find the
    // row and swallow the arrows the caret needs.
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const row = target.closest<HTMLElement>('[role="treeitem"]');
    if (row === null) return;

    const rows = rowsOf();
    const here = rows.indexOf(row);
    if (here === -1) return;

    const folderKey = row.getAttribute("data-folder-key");
    const isFolder = folderKey !== null;
    const expanded = row.getAttribute("aria-expanded");

    const handled = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };

    switch (e.key) {
      case "ArrowDown":
        handled();
        focusRow(rows[Math.min(here + 1, rows.length - 1)]);
        return;
      case "ArrowUp":
        handled();
        focusRow(rows[Math.max(here - 1, 0)]);
        return;
      case "ArrowRight":
        // On a collapsed folder, open it. On an expanded one, step into its
        // first child, which is the next row by construction in a flattened
        // tree. On a note (a leaf) it does nothing, which is what the pattern
        // says a leaf does.
        if (!isFolder) return;
        handled();
        if (expanded === "false") toggleFolder(folderKey);
        else if (expanded === "true") focusRow(rows[here + 1]);
        return;
      case "ArrowLeft": {
        // On an expanded folder, close it. Otherwise step out to the parent,
        // which in a flattened tree is the nearest preceding row one level up.
        //
        // `handled()` comes AFTER the decision in every branch, the way
        // ArrowRight above already does it. Consuming the key first meant
        // ArrowLeft on a top-level leaf was a dead key: it silenced the
        // document handler and killed the browser default while doing
        // nothing itself.
        if (isFolder && expanded === "true") {
          handled();
          toggleFolder(folderKey);
          return;
        }
        const level = Number(row.getAttribute("aria-level") ?? "1");
        for (let i = here - 1; i >= 0; i--) {
          if (Number(rows[i]?.getAttribute("aria-level") ?? "1") < level) {
            handled();
            focusRow(rows[i]);
            return;
          }
        }
        return;
      }
      case "Enter":
      case " ": {
        handled();
        if (isFolder) {
          toggleFolder(folderKey);
          return;
        }
        const noteId = row.getAttribute("data-note-id");
        if (noteId !== null) open(noteId);
        return;
      }
      default:
        return;
    }
  };
}

/**
 * Inline-rename trigger orchestrator — derives current bytes via
 * `noteRead` and dispatches `commitRename` (Q9 helper). Extracted so
 * unit tests can verify the read-then-commit composition without
 * rendering a tree.
 */
export async function executeRenameCommit(
  noteId: NoteId,
  newTitle: string,
  ctx: Pick<UseSelectedNoteReturn, "commitRename">,
  read: (id: NoteId) => Promise<string> = noteRead,
  flush: () => Promise<void> = flushBeforeFrontmatterWrite,
): Promise<void> {
  // BEFORE the read, and the order is the defect rather than a preference.
  // This is a read-patch-write against disk on a note that may be open and
  // dirty in a pane, so it owes the same step every other writer of that class
  // owes (`flushBeforeFrontmatterWrite`'s header). `commitRename` does flush,
  // but only for INBOUND notes, over a `sources` list that explicitly filters
  // out `args.renamedNoteId` (`renameInbound.ts`), so the renamed note's OWN
  // dirty pane was never covered and the bytes read here were the pre-typing
  // ones. What that cost: the stale body written under the new title, the
  // dirty pane skipping its reload because `hasPendingWork()` is true, and its
  // next autosave putting the pre-rename title back. The rename silently
  // reverts, or, with the section 11.3 hash on, mints a keep-both conflict
  // copy and drops the user's typing out of the open note.
  //
  // Injectable for the same reason `read` is: the test asserts the ORDER, and
  // an order is not observable from a return value.
  await flush();
  const currentBytes = await read(noteId);
  await ctx.commitRename(noteId, currentBytes, newTitle);
}

const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 14px 6px",
  flexShrink: 0,
};

const HEADER_BUTTON_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-3)",
  background: "transparent",
  border: 0,
  padding: "2px 6px",
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
};

/** Right-aligned cluster holding the header's "+" new-item menu button. */
const HEADER_ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
};

// The header's single "+" button and its dropdown (New note / New note from
// template / New folder) — replaces the former three-button cluster.
/**
 * The sidebar's three create actions, as explicit icon buttons.
 *
 * They were folded behind a single `+` dropdown in #230, and #282 then added a
 * fourth row to it. The dropdown was the wrong trade on this surface: the three
 * things a person creates in a notes app are a note, a folder and a drawing,
 * and putting all three one click plus one read behind a `+` taxes the common
 * case to tidy a row that had room for them.
 *
 * "New note from template" does NOT get a button — four icons is a toolbar, and
 * it is the rarest of the four by a distance. It stays on the command palette
 * as `templates.new-note`, which is reachable from the search row immediately
 * to the left of these.
 *
 * Order is drawing, folder, note: the most-used sits nearest the tree it acts
 * on, and the pointer travels least for the thing it does most.
 */
function NotesActionsBar({
  onNewFolder,
  onCreate,
  onNewDrawing,
}: {
  onNewFolder: () => void;
  onCreate: () => void;
  onNewDrawing: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      <IconButton
        icon="image-plus"
        iconSize={15}
        label={t("notes.list.newDrawingMenu")}
        testId="notes.new-drawing"
        tooltip
        onClick={onNewDrawing}
      />
      <IconButton
        icon="folder-plus"
        iconSize={15}
        label={t("notes.list.newFolder")}
        testId="notes.new-folder"
        tooltip
        onClick={onNewFolder}
      />
      <IconButton
        icon="file-plus"
        iconSize={15}
        label={t("notes.list.newNote")}
        testId="notes.create"
        tooltip
        onClick={onCreate}
      />
    </div>
  );
}

/** Leading group: the collapse chevron + the "Notes" eyebrow, kept together
 *  so the header stays a clean two-group `space-between` row (MYND-137). */
/** The header's leading half: the search row, which takes everything the
 *  create buttons do not. `HEADER_ROW_STYLE` is `space-between`, so without
 *  the grow this box sized to its content and the gap between the two halves
 *  was dead space rather than the search field. */
const HEADER_LEAD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flex: 1,
  minWidth: 0,
};

/** "Favorites" eyebrow row — pinned above the "Notes" header (MYND-183). Same
 *  eyebrow treatment as the Notes header, no action icons. */
const FAV_HEADER_STYLE: CSSProperties = {
  padding: "14px 14px 6px",
  flexShrink: 0,
};

/** Hairline divider between the Favorites section and the Notes tree below. */
const FAV_DIVIDER_STYLE: CSSProperties = {
  height: 1,
  background: "var(--line-1)",
  opacity: 0.65,
  margin: "6px 14px 0",
  flexShrink: 0,
};

const EMPTY_WRAPPER_STYLE: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 20px 40px",
  textAlign: "center",
  gap: 14,
  minWidth: 0,
};

const SIDEBAR_OUTER_STYLE: CSSProperties = {
  // Fills the layout-seam wrapper, which owns the resizable width (MYND-137).
  // `flex: 1` lets it fill the height below the ribbon header in the
  // sidebar column (MYND-166); harmless outside a flex parent.
  width: "100%",
  flex: 1,
  background: "var(--paper-2)",
  borderInlineEnd: "1px solid var(--line-1)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

/** The selection live region's box: the shared visually-hidden recipe, plus
 *  the positioning that takes it out of flow.
 *
 *  Spread from `VISUALLY_HIDDEN` rather than restated (myne#728, review). A
 *  hand-rolled second copy lived here for one round, repeating that file's
 *  own rationale in its own words, while the primitive's header opens "The
 *  one definition of 'present to a screen reader, absent to the eye'" and
 *  `e2e/screen-capture-override.e2e.ts` asserts its literal
 *  `clip-path: inset(50%)` precisely so the constant is the one authority
 *  behind that assertion. A third copy would have made that false. */
const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  ...VISUALLY_HIDDEN,
  position: "absolute",
  margin: -1,
  padding: 0,
  // The pre-`clip-path` fallback, kept for the same reason the primitive
  // documents: a live region that is merely off-screen still announces.
  clip: "rect(0 0 0 0)",
  border: 0,
};

const LIST_OUTER_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

/** Horizontal indent applied to a note row per tree depth level (matches the
 *  folder-row indent). */
const NOTE_INDENT_PER_LEVEL = 18;

// Folder disclosure animation (expand/collapse). Each revealed/hidden
// descendant row plays a staggered enter/exit keyframe. `BASE_MS` mirrors
// `--duration-base` (tokens.css); the JS deferral timer must outlast the
// slowest row (base + the capped stagger) so the fold/cleanup fires only after
// the motion is done. Stagger is capped so a folder with many children doesn't
// drag the cleanup out indefinitely.
const TREE_ANIM_BASE_MS = 180;
/**
 * Total time the cascade is allowed to span, independent of row count
 * (MYND-622).
 *
 * The stagger used to be a fixed 18ms per row, clamped at the 8th. That reads
 * fine for a small folder and badly for a populated one: the first eight rows
 * tick down in sequence and then every remaining row arrives at once, so a long
 * nested folder opens as a short cascade followed by a wall. Spreading a FIXED
 * budget across however many rows there are keeps the motion continuous at any
 * size — a handful of rows stay near-simultaneous and snappy, a hundred rows
 * flow evenly instead of slamming.
 */
const TREE_ANIM_STAGGER_SPAN_MS = 144;
const TREE_ANIM_TOTAL_MS = TREE_ANIM_BASE_MS + TREE_ANIM_STAGGER_SPAN_MS + 60;

const NEW_FOLDER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 14px",
};

const NEW_FOLDER_INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
  background: "var(--paper)",
  border: "1px solid var(--accent)",
  borderRadius: "var(--radius-1)",
  padding: "3px 6px",
  outline: "none",
};

const BLOCK_NOTICE_STYLE: CSSProperties = {
  margin: "6px 10px",
  padding: "8px 10px",
  background: "var(--warning-soft, var(--paper))",
  borderInlineStart: "2px solid var(--line-3)",
  borderRadius: "var(--radius-1)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-2)",
  flexShrink: 0,
};

const CASE_MERGE_STYLE: CSSProperties = {
  margin: "6px 10px",
  padding: "10px",
  background: "var(--accent-soft)",
  borderRadius: 4,
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-2)",
  flexShrink: 0,
};

const CASE_MERGE_ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  justifyContent: "flex-end",
  marginTop: "var(--space-2)",
};

/** Optional props.
 *  the template flow (MYND-190); omitted → the caret is not rendered.
 *
 *  The sidebar collapse toggle moved to a floated `TitleBarToggle` in the
 *  editor's top-left corner, and the vault switcher to the
 *  `SidebarVaultSwitcher` header above this list (MYND-166); neither is
 *  hosted here. */
interface NoteListProps {
  /** UI hooks for the per-note export flow (MYND-116) — the Editor's
   *  structured toast sink + the pre-flight "Include N attachments"
   *  modal hook. Optional so isolated NoteList renders stay inert. */
  exportHooks?: NoteExportUiHooks;
}

/** Filter-builder open state (MYND-282): creating a new view, or editing an
 *  existing one (carrying the parsed draft — `null` when its filter is outside
 *  the builder's representable set, so it opens read-only). */
type BuilderState =
  | { mode: "new" }
  | { mode: "edit"; view: SavedView; draft: FilterDraft | null };

const EMPTY_DRAFT: FilterDraft = { combinator: "and", groups: [] };

export function NoteList({ exportHooks }: NoteListProps = {}) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  // Opening a note used to also have to swap the center view back to the
  // editor. As a tab it does not: `ctx.open` puts the note in the focused pane,
  // which replaces whatever tab was there (myne-md/myne#773).
  const openNote = useCallback(
    (id: NoteId): Promise<unknown> => ctx.open(id),
    [ctx],
  );
  // Folder-management state + handlers (deliberate_folders set, context menu,
  // create / rename / delete / drag-drop). Owns the deliberate set.
  const fm = useFolderManagement(ctx);

  // Saved Views (MYND-274): the sidebar "Views" section reads the saved-view
  // list from prefs and opens a view as a workspace tab. `ws.openView` is the
  // task-2 entry. Views are rendered in display order (view_order first, then
  // any not-yet-ordered).
  const ws = useWorkspace();
  // The saved-view list. Refresh is handled centrally: the saved-view prefs
  // writers bump the prefs nonce at the IPC chokepoint and `usePrefs` re-reads
  // on that bump — so the mutations below don't reload explicitly (no per-write
  // double read, and a save from a sibling surface like the Tag browser lands
  // here too).
  const { prefs: viewsPrefs } = usePrefs();
  // The join of `saved_views` with `view_order` lives in one pure helper now
  // that the Views manager needs the same order: two copies of "walk the order,
  // then append the leftovers" are two answers waiting to disagree.
  const orderedViews = useMemo<SavedView[]>(
    () => orderSavedViews(viewsPrefs.saved_views, viewsPrefs.view_order),
    [viewsPrefs.saved_views, viewsPrefs.view_order],
  );
  // Views feature toggle (device-local): the "Views" entry shows only when
  // enabled. Effective = stored pref, else back-compat default (has any views).
  // Re-read on the change event so the sidebar reflects the Settings toggle live.
  const [viewsPrefNonce, bumpViewsPref] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const onChange = () => bumpViewsPref();
    window.addEventListener(VIEWS_ENABLED_EVENT, onChange);
    return () => window.removeEventListener(VIEWS_ENABLED_EVENT, onChange);
  }, []);
  const showViews = useMemo(
    () => viewsEnabled(orderedViews.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderedViews.length, viewsPrefNonce],
  );
  // Filter builder (MYND-282): "+ New view" no longer creates a blank view
  // immediately — it opens the builder empty. "Edit filter…" (ViewsSection
  // context menu) reopens it seeded with an existing view's filter, parsed back
  // into the draft. Saving with no conditions yields an all-pages view (the prior
  // behavior as the empty case); any conditions compose a `FilterNode` via the
  // pure `filterDraft` core. An unrepresentable filter (`draft === null`) opens
  // read-only (fail-safe) rather than silently dropping conditions.
  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const handleNewView = useCallback(() => setBuilder({ mode: "new" }), []);
  const handleEditFilter = useCallback(
    (id: string) => {
      const view = viewsPrefs.saved_views.find((v) => v.id === id);
      if (view === undefined) return;
      setBuilder({ mode: "edit", view, draft: filterNodeToDraft(view.filters) });
    },
    [viewsPrefs.saved_views],
  );
  const handleSaveFilter = useCallback(
    (draft: FilterDraft) => {
      const current = builder;
      setBuilder(null);
      const filters = draftToFilterNode(draft);
      void (async () => {
        try {
          if (current?.mode === "edit") {
            // A local edit: the definition and (where this device already
            // approved the view) the approval of its new version land in ONE
            // prefs write, so editing your own view never leaves it unapproved.
            const stored = viewsPrefs.saved_views.find((v) => v.id === current.view.id);
            const previous = stored ?? current.view;
            await saveLocalViewEdit(
              previous,
              { ...current.view, filters },
              isViewApproved(previous, viewsPrefs.view_approvals),
            );
          } else {
            const id = crypto.randomUUID();
            await upsertSavedView({ id, name: "New view", view_type: "cards", filters });
            ws.openView(id);
          }
        } catch {
          // Save failure surfaces via backend tracing; the user can retry.
        }
      })();
    },
    [builder, ws, viewsPrefs.saved_views, viewsPrefs.view_approvals],
  );
  // View display settings (cards cover image / aspect ratio / card size). A
  // sibling of the filter builder: a separate modal opened from the ViewsSection
  // context menu ("View settings…", cards-only). Kept off `BuilderState` (which
  // is `FilterDraft`-typed) — it edits the cards-render fields, not the filter.
  const [viewSettings, setViewSettings] = useState<SavedView | null>(null);
  const handleViewSettings = useCallback(
    (id: string) => {
      const view = viewsPrefs.saved_views.find((v) => v.id === id);
      if (view === undefined) return;
      setViewSettings(view);
    },
    [viewsPrefs.saved_views],
  );
  const handleSaveViewSettings = useCallback(
    (patch: ViewDisplayPatch) => {
      const current = viewSettings;
      setViewSettings(null);
      if (current === null) return;
      // Spread merges the patch onto the view; a field cleared to `undefined`
      // overrides the stored value and drops off the wire (JSON omits undefined),
      // matching the Rust `skip_serializing_if = "None"` on these fields.
      void (async () => {
        try {
          await saveLocalViewEdit(
            current,
            { ...current, ...patch },
            isViewApproved(current, viewsPrefs.view_approvals),
          );
        } catch {
          /* surfaced via backend tracing */
        }
      })();
    },
    [viewSettings, viewsPrefs.view_approvals],
  );
  // The vault's frontmatter property-key universe — the option set for the view
  // settings' group / sort / column pickers + cover-image suggestions. Loaded
  // from the `vault_indices_property_keys` accessor when the modal opens (fresh
  // each open, so the pickers reflect the current index).
  const [viewPropertyKeys, setViewPropertyKeys] = useState<string[]>([]);
  useEffect(() => {
    if (viewSettings === null) return;
    let cancelled = false;
    void vaultIndicesPropertyKeys()
      .then((keys) => {
        if (!cancelled) setViewPropertyKeys(keys);
      })
      .catch(() => {
        /* index hiccup → empty pickers; the free-text cover field still works */
      });
    return () => {
      cancelled = true;
    };
  }, [viewSettings]);

  // Task 6 — view management: rename / delete / reorder, each persisted via
  // #3's prefs API then reflected immediately by re-reading prefs. A deleted
  // view's open tab is left as a generic view host (the "shown-missing" pinned
  // choice — no crash; the user closes it).
  const handleRenameView = useCallback(
    (id: string, name: string) => {
      const view = viewsPrefs.saved_views.find((v) => v.id === id);
      if (view === undefined) return;
      void (async () => {
        try {
          await saveLocalViewEdit(
            view,
            { ...view, name },
            isViewApproved(view, viewsPrefs.view_approvals),
          );
        } catch {
          /* surfaced via backend tracing */
        }
      })();
    },
    [viewsPrefs.saved_views],
  );
  const handleDeleteView = useCallback(
    (id: string) => {
      void (async () => {
        try {
          await deleteSavedView(id);
        } catch {
          /* surfaced via backend tracing */
        }
      })();
    },
    [],
  );
  const handleMoveView = useCallback(
    (id: string, dir: -1 | 1) => {
      const nextOrder = moveInOrder(
        orderedViews.map((v) => v.id),
        id,
        dir,
      );
      void (async () => {
        try {
          await setViewOrder(nextOrder);
        } catch {
          /* surfaced via backend tracing */
        }
      })();
    },
    [orderedViews],
  );

  // Expansion state — the folded keys of folders the user has OPENED. Default
  // empty = every folder collapsed; a folder that first appears is absent here,
  // so it comes in closed (a fresh vault, a newly-created folder, and an Obsidian
  // import all open collapsed rather than sprawling). PERSISTED across restart
  // (MYND-455): the set is carried at the container level of the workspace blob
  // (MYW1, §9.7 — window-global session/view state, AS3, already inside the AEAD
  // envelope). The container is the SINGLE owner — the sidebar renders straight
  // off it rather than mirroring it into local state. That is what makes the two
  // invariants structural rather than bookkeeping: the async restore simply
  // replaces the value (nothing to "hydrate"), and there is no initial empty
  // local set that could clobber the persisted one before restore lands.
  const expanded = useMemo<ReadonlySet<string>>(
    () => new Set(ws.expandedFolders),
    [ws.expandedFolders],
  );
  const setExpanded = ws.setExpandedFolders;
  // Mirror the latest committed value so `toggleFolder` can read it
  // synchronously (decide expand-vs-collapse) without a stale closure.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  // Active disclosure animation, if any. `nonce` guards against a stale timer
  // clearing a newer animation. `mode` picks the enter vs exit keyframe applied
  // to the toggled folder's descendant rows.
  const [treeAnim, setTreeAnim] = useState<{
    folderKey: string;
    mode: "in" | "out";
    nonce: number;
  } | null>(null);
  const treeAnimNonce = useRef(0);
  const treeAnimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Folder key of a collapse whose fold is deferred until its exit animation
  // ends. If a new toggle interrupts it, we flush this fold immediately so the
  // interrupted folder doesn't get stuck visually-open.
  const pendingCollapse = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (treeAnimTimer.current) clearTimeout(treeAnimTimer.current);
    },
    [],
  );
  const toggleFolder = useCallback((key: string) => {
    // `expanded` holds opened folders — a key present means open. Toggling an
    // open folder collapses it (delete the key); a closed one expands (add it).
    const collapsing = expandedRef.current.has(key);
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (treeAnimTimer.current) {
      clearTimeout(treeAnimTimer.current);
      treeAnimTimer.current = null;
    }
    // Flush any interrupted deferred collapse before starting a new operation.
    if (pendingCollapse.current !== null && pendingCollapse.current !== key) {
      const stuck = pendingCollapse.current;
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(stuck);
        return next;
      });
    }
    pendingCollapse.current = null;
    // Reduced motion (or any non-animated path): flip immediately.
    if (reduce) {
      setTreeAnim(null);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (collapsing) next.delete(key);
        else next.add(key);
        return next;
      });
      return;
    }
    treeAnimNonce.current += 1;
    const nonce = treeAnimNonce.current;
    if (collapsing) {
      // Defer the actual fold until the exit animation finishes — the
      // descendant rows stay in `rows` and play `myne-tree-row-out` meanwhile.
      pendingCollapse.current = key;
      setTreeAnim({ folderKey: key, mode: "out", nonce });
      treeAnimTimer.current = setTimeout(() => {
        pendingCollapse.current = null;
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        setTreeAnim((a) => (a?.nonce === nonce ? null : a));
        treeAnimTimer.current = null;
      }, TREE_ANIM_TOTAL_MS);
    } else {
      // Expand now — the descendant rows mount and play `myne-tree-row-in`.
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      setTreeAnim({ folderKey: key, mode: "in", nonce });
      treeAnimTimer.current = setTimeout(() => {
        setTreeAnim((a) => (a?.nonce === nonce ? null : a));
        treeAnimTimer.current = null;
      }, TREE_ANIM_TOTAL_MS);
    }
  }, []);

  // The folder tree is a derived view of each note's `folder:` field unioned
  // with the deliberate-folder set (Task 3 `deriveFolderTree`). Memo on cache
  // identity (mutations replace the Map) + the deliberate set.
  // Trashed notes (value-strict `trashed:` marker) are excluded from the live
  // sidebar everywhere — tree, rows, favorites — via a single derived
  // `live` view of the cache (MYND-133). The Trash panel reads the complement
  // (`trashedRecords`). Restore clears the marker → the note re-enters `live`.
  // Folder-archived subtrees (archived_folders) leave the working set as a UNIT
  // — folded keys computed once, threaded into `liveCache` (excludes their
  // notes) and the deliberate filter (drops archived empty folders so they
  // don't re-surface as empty nodes). resolverCache is untouched (folder-
  // archived notes stay backlink/graph/search targets — folder-archive).
  const archivedKeys = useMemo(
    () => archivedFolderKeys(fm.archivedFolders),
    [fm.archivedFolders],
  );
  const live = useMemo(
    () => liveCache(ctx.cache, archivedKeys),
    [ctx.cache, archivedKeys],
  );
  // Folder-notes feature gate (myne-md/myne#661). Read through this screen's own
  // `usePrefs` so a toggle from Settings re-derives the tree live (the prefs
  // nonce bump the setter performs). When off, every note is projected with
  // `folderIndex: false`, so `deriveFolderTree` treats it as ordinary: no index
  // note is hidden or badged, and the create/open affordances (driven by
  // `indexNoteId`) never appear. Zeroing the field in the projection, rather
  // than teaching `deriveFolderTree` about the pref, keeps this gate identical
  // to the resolver-note one (`resolverNotesFromCache`), the vault's other
  // folder_index reader.
  const folderNotesEnabled = viewsPrefs.folder_notes_enabled;
  const tree = useMemo(
    () =>
      deriveFolderTree(
        Array.from(live.values()).map((r) => ({
          noteUuid: r.noteUuid,
          folder: r.folder,
          folderIndex: folderNotesEnabled && r.folderIndex,
        })),
        fm.deliberate,
        fm.archivedFolders,
      ),
    [live, fm.deliberate, fm.archivedFolders, folderNotesEnabled],
  );
  // Keep the handlers' tree reference current (delete-emptiness, case-merge).
  fm.treeRef.current = tree;
  // Flat folder choices for the filter builder's folder-condition picker, in
  // tree order, indented by depth (the canonical path is the stored value; the
  // engine folds it via `folderKey`).
  const folderOptions = useMemo<FolderOption[]>(() => {
    const out: FolderOption[] = [];
    const walk = (nodes: readonly FolderNode[]) => {
      for (const n of nodes) {
        out.push({ path: n.path, label: `${" ".repeat(n.depth - 1)}${n.name}` });
        walk(n.children);
      }
    };
    walk(tree.roots);
    return out;
  }, [tree]);
  // The same folders for the MOVE pickers, in the shape a collapsible tree needs
  // (myne#952): the bare name plus its depth, instead of a label pre-indented
  // with spaces. Depth is 1-based off the tree — the picker's own root row
  // ("Vault root") sits at 0, so a top-level folder is its child by exactly one
  // level and the indent rail lands where the eye expects it.
  const folderChoices = useMemo<FolderChoice[]>(() => {
    const out: FolderChoice[] = [];
    const walk = (nodes: readonly FolderNode[]) => {
      for (const n of nodes) {
        out.push({ path: n.path, name: n.name, depth: n.depth });
        walk(n.children);
      }
    };
    walk(tree.roots);
    return out;
  }, [tree]);
  // Folders are closed unless opened. The flatten pass consumes a `collapsed`
  // set, so derive it as every folder key NOT in `expanded` — keeping the pure
  // `flattenVisibleRows` contract while making "closed" the default. A key that
  // lingers in `expanded` for a folder that has since vanished is harmless (it
  // matches no node); we never prune, so a folder that briefly drops out of the
  // tree during async note loading keeps its opened state.
  const collapsed = useMemo(() => {
    const out = new Set<string>();
    const walk = (nodes: readonly FolderNode[]): void => {
      for (const n of nodes) {
        if (!expanded.has(n.key)) out.add(n.key);
        walk(n.children);
      }
    };
    walk(tree.roots);
    return out;
  }, [tree, expanded]);
  // Open a folder (and its ancestors) so a child created inside it — a new note
  // or a new subfolder — is visible under the default-collapsed tree. Root
  // ("" / null) has no ancestor to open.
  const revealFolder = useCallback((path: string) => {
    const norm = normalizeFolderPath(path);
    if (norm === null) return;
    const keys = ancestorPaths(norm).map(foldSegment);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });
  }, []);
  // A note entering inline-rename must be VISIBLE — but under the default-
  // collapsed tree its folder may be shut. The context-menu "new note here"
  // reveals synchronously; this catches the rest: the root-level create entry
  // points (Cmd+N, palette, top-bar, new tab) resolve their target folder from
  // prefs ("current"/"specific" note location) and settle it into the cache a
  // beat AFTER `renamingId` is set, plus a plain rename of an existing filed
  // note. Reveal once per rename session (keyed by the note id) so a manual
  // collapse mid-rename is not fought; the `folder === null` (root) case reveals
  // nothing and needs nothing.
  // `justCreatedId` joined `renamingId` here with myne#653. Creating a note no
  // longer enters sidebar rename (the note carries its own `title:` field now),
  // and this effect was the only thing revealing the destination folder, so
  // without it a note created into a collapsed folder was selected, opened, and
  // nowhere to be seen in the tree. A drawing still enters rename and still
  // arrives through the first branch.
  const revealedRenameId = useRef<NoteId | null>(null);
  useEffect(() => {
    const id = ctx.renamingId ?? ctx.justCreatedId;
    if (id === null) {
      revealedRenameId.current = null;
      return;
    }
    if (revealedRenameId.current === id) return;
    const folder = ctx.cache.get(id)?.folder ?? null;
    if (folder !== null) {
      revealFolder(folder);
      revealedRenameId.current = id;
    }
  }, [ctx.renamingId, ctx.justCreatedId, ctx.cache, revealFolder]);
  // Unified manual order (item_order) interleaves folders + loose notes per
  // container (MYND-183); flatten owns all display ordering.
  const rows = useMemo(
    () => flattenVisibleRows(tree, live, collapsed, fm.itemOrder, ctx.justCreatedId),
    [tree, live, collapsed, fm.itemOrder, ctx.justCreatedId],
  );
  // Per-row disclosure-animation lookup: when `treeAnim` is active, the toggled
  // folder's contiguous descendant rows (depth > the folder's, until the depth
  // returns to its level) get a staggered enter/exit treatment. Keyed by
  // VirtualList row key so `renderItem` can hand each row's `mode` + `delay` to
  // its `DisclosureWrapper` without prop-drilling.
  const treeAnimRows = useMemo(() => {
    const map = new Map<string, { mode: "in" | "out"; delay: number }>();
    if (treeAnim === null) return map;
    const anchor = rows.findIndex((r) => r.key === `f-${treeAnim.folderKey}`);
    if (anchor < 0) return map;
    const folderDepth = rows[anchor]!.depth;
    // Count the affected rows first so the stagger can be spread across them
    // rather than clamped after the eighth (see TREE_ANIM_STAGGER_SPAN_MS).
    let end = anchor + 1;
    while (end < rows.length && rows[end]!.depth > folderDepth) end++;
    const count = end - (anchor + 1);
    // One row needs no cascade; `count - 1` divisions put the last row exactly
    // at the end of the budget.
    const step = count > 1 ? TREE_ANIM_STAGGER_SPAN_MS / (count - 1) : 0;
    for (let r = anchor + 1; r < end; r++) {
      const delay = Math.round((r - anchor - 1) * step);
      map.set(rows[r]!.key, { mode: treeAnim.mode, delay });
    }
    return map;
  }, [treeAnim, rows]);
  // Folder-index lookup (MYND-370): note-id → its role in its folder. The
  // authoritative winner (`indexNoteId`, pinned by `deriveFolderTree`) reads
  // "index"; every claimant that lost the tiebreak (`indexConflictIds`) reads
  // "conflict". Threaded into every NoteRow so the badge / conflict indicator
  // come from the FolderNode, not the per-note `folderIndex` flag alone (which
  // can't tell the winner from a loser).
  const folderIndexRoles = useMemo(() => {
    const map = new Map<NoteId, "index" | "conflict">();
    const walk = (nodes: readonly FolderNode[]): void => {
      for (const n of nodes) {
        if (n.indexNoteId !== null) map.set(n.indexNoteId, "index");
        for (const id of n.indexConflictIds) map.set(id, "conflict");
        walk(n.children);
      }
    };
    walk(tree.roots);
    return map;
  }, [tree]);
  // Folder-key → its index note id (MYND-370). Drives the single-folder-note
  // guard: the per-note "Set as folder note" action is offered only when the
  // note's folder has NO index yet, so a second one can never be designated.
  const folderIndexByKey = useMemo(() => {
    const map = new Map<string, NoteId>();
    const walk = (nodes: readonly FolderNode[]): void => {
      for (const n of nodes) {
        if (n.indexNoteId !== null) map.set(n.key, n.indexNoteId);
        walk(n.children);
      }
    };
    walk(tree.roots);
    return map;
  }, [tree]);
  // Favorites section rows (MYND-183) — note rows keyed `fav-<id>`, rendered
  // above the tree. Stale-UUID GC (render half) is in `buildFavoriteRows`; a
  // trashed favorite is absent from `live` so it is hidden until restore.
  const favRows = useMemo(
    () => buildFavoriteRows(fm.favorites, live),
    [fm.favorites, live],
  );
  // Keyboard navigation: Favorites first, then the tree; `visibleNoteIds`
  // dedupes a note shown in both down to its (reachable) Favorites copy.
  const navIds = useMemo(
    () => visibleNoteIds([...favRows, ...rows]),
    [favRows, rows],
  );
  const isEmpty = rows.length === 0 && favRows.length === 0;

  // Trash + Archive panels (MYND-133 / MYND-331). Their sidebar-footer rows are
  // gone (myne-md/myne#762) — the `trash.open` / `archive.open` registry commands
  // are the entry points, reached from the left ribbon or the palette — but the
  // panels themselves still mount here, because this is where the note cache and
  // the folder-management handles they need already live.
  const [trashOpen, setTrashOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Palette-gap Wave 4: register the sidebar-owned surfaces so the command
  // palette (a separate subtree) can open them. Cleared on unmount so a
  // non-editor stage's actions no-op.
  useEffect(() => {
    sidebarCommands.openTrash = () => setTrashOpen(true);
    sidebarCommands.openArchive = () => setArchiveOpen(true);
    sidebarCommands.newFolder = () => fm.startNewFolder("");
    return () => {
      sidebarCommands.openTrash = undefined;
      sidebarCommands.openArchive = undefined;
      sidebarCommands.newFolder = undefined;
    };
  }, [fm]);
  // F2 global keymap → enter inline-rename on the selected row.
  useEffect(() => {
    const handler = makeF2KeydownHandler(ctx);
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [ctx]);

  // Keyboard nav (↑/↓/Enter/Home/End/PgUp/PgDn) — document-level so the
  // editor body can stay focused naturally; handler bails out on
  // editable targets so it doesn't fight CM6 / textarea key handling.
  useEffect(() => {
    const handler = makeKeyboardNavHandler({
      sortedIds: navIds,
      selectedId: ctx.selectedId,
      renamingId: ctx.renamingId,
      select: ctx.select,
      open: openNote,
      clearMultiSelection: ctx.clearMultiSelection,
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [navIds, ctx, openNote]);

  const handleCreate = useCallback(() => {
    void ctx.createAndStartRename().catch((err) => {
      // Surface in dev console; production UX uses BottomBar toast (T27)
      // once the save-status pipeline is wired. Silent-fail here is
      // acceptable — the IPC failure is the rare path.
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[NoteList] createNote failed:", err);
      }
    });
  }, [ctx]);

  return (
    <aside style={SIDEBAR_OUTER_STYLE}>
      {isEmpty ? (
        <EmptyState
          onCreate={handleCreate}
          fm={fm}
        />
      ) : (
        <PopulatedList
          rows={rows}
          favRows={favRows}
          navIds={navIds}
          treeAnimRows={treeAnimRows}
          folderChoices={folderChoices}
          folderIndexRoles={folderIndexRoles}
          folderIndexByKey={folderIndexByKey}
          onToggleFolder={toggleFolder}
          onRevealFolder={revealFolder}
          onCreate={handleCreate}
          fm={fm}
          exportHooks={exportHooks}
          showTimestamps={viewsPrefs.show_note_timestamps}
        />
      )}
      {showViews && (
        <ViewsSection
          views={orderedViews}
          activeViewId={
            ws.focusedLeaf.activeTab?.kind === "view"
              ? ws.focusedLeaf.activeTab.id
              : null
          }
          onOpenView={(id) => ws.openView(id)}
          onNewView={handleNewView}
          onEditFilter={handleEditFilter}
          onViewSettings={handleViewSettings}
          onRename={handleRenameView}
          onDelete={handleDeleteView}
          onMoveView={handleMoveView}
        />
      )}
      {viewSettings !== null && (
        <ViewSettings
          title={
            viewSettings.name.trim() === ""
              ? t("notes.list.viewSettingsTitle")
              : viewSettings.name
          }
          initial={{
            view_type: viewSettings.view_type,
            group_by: viewSettings.group_by,
            sort: viewSettings.sort,
            columns: viewSettings.columns,
            image: viewSettings.image,
            image_aspect_ratio: viewSettings.image_aspect_ratio,
            card_size: viewSettings.card_size,
            write_fields: viewSettings.write_fields,
          }}
          version={viewSettings.version}
          // Export is offered only where the host has a path-taking save dialog
          // (desktop). The web client cannot write the file and cannot import one
          // either, so the action is absent there rather than half-present.
          onExport={
            canExportViewManifest()
              ? () => {
                  void exportViewManifest(viewSettings);
                }
              : undefined
          }
          propertyKeys={viewPropertyKeys}
          onCancel={() => setViewSettings(null)}
          onSave={handleSaveViewSettings}
        />
      )}
      {builder !== null && (
        <FilterBuilder
          title={
            builder.mode === "edit"
              ? t("notes.list.editFilterTitle")
              : t("notes.list.newViewTitle")
          }
          initialDraft={
            builder.mode === "edit" ? (builder.draft ?? EMPTY_DRAFT) : EMPTY_DRAFT
          }
          representable={builder.mode === "new" || builder.draft !== null}
          folderOptions={folderOptions}
          onCancel={() => setBuilder(null)}
          onSave={handleSaveFilter}
        />
      )}
      <TrashPanel open={trashOpen} onClose={() => setTrashOpen(false)} />
      <ArchivePanel
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        archivedFolders={fm.archivedFolders}
        onRestoreFolder={fm.restoreFolder}
        onDeleteFolderToTrash={fm.deleteArchivedFolderToTrash}
      />
    </aside>
  );
}

function EmptyState({
  onCreate,
  fm,
}: {
  onCreate: () => void;
  fm: FolderManagement;
}) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  return (
    <div style={LIST_OUTER_STYLE}>
      <div style={HEADER_ROW_STYLE}>
        {/* The `NOTES` heading that used to sit here is gone (myne-md/myne#773).
            It labelled a region that can only ever contain notes, directly
            under the vault picker that already says where you are — a row of
            chrome carrying no information, on the surface with the least room
            to spare. The space now holds the app's only clickable route into
            the command palette. */}
        <div style={HEADER_LEAD_STYLE}>
          <SidebarSearchRow />
        </div>
        <div style={HEADER_ACTIONS_STYLE}>
          <NotesActionsBar
            onNewFolder={() => fm.startNewFolder("")}
            onCreate={onCreate}
            onNewDrawing={() => void ctx.createDrawingAndStartRename().catch(() => {})}
          />
        </div>
      </div>
      {fm.newFolder !== null && (
        <NewFolderInput
          depth={0}
          parentPath={fm.newFolder.parentPath}
          onCommit={fm.commitNewFolder}
          onCancel={fm.cancelNewFolder}
        />
      )}
      {/* The first thing a new user sees in this app. It used to be the string
          "No notes yet." above a button — true, and saying nothing about what
          the surface is for. It is also the one zero state in the sidebar that
          is a DESTINATION rather than a transient, which is why it carries the
          brand field and the filtered states below do not. */}
      <div style={EMPTY_WRAPPER_STYLE}>
        <ZeroState
          variant="firstRun"
          icon="file-text"
          title={t("notes.list.emptyState")}
          body={t("notes.list.emptyBody")}
          size="sm"
          testId="notes.empty-state"
          action={
            <Button variant="primary" icon="file-plus" onClick={onCreate}>
              {t("notes.list.createFirstNote")}
            </Button>
          }
        />
      </div>
    </div>
  );
}

/**
 * Wraps a folder-tree row during an expand/collapse so the row's HEIGHT
 * collapses (`grid-template-rows` 1fr↔0fr) alongside the opacity fade. The
 * VirtualList's per-row ResizeObserver picks up the shrinking height each frame
 * and reflows its spacers, so the fold reads as a smooth glide instead of the
 * rows fading in place and the list snapping shut once they're finally removed.
 *
 * Idle (`anim === null`): a plain 1fr grid with no transition and overflow
 * visible — structurally identical to the animating state so the row never
 * remounts (a remount would flash at the end of an expand) and the rename
 * input's focus ring isn't clipped. Entering/exiting flips `open` on the frame
 * AFTER the resting "from" state paints, giving the browser a value to
 * transition from. `overflow: hidden` is applied only while animating (a
 * collapse/expand never coincides with a rename). Reduced motion zeroes
 * transition-duration globally (tokens.css) and NoteList skips the deferred
 * path, so this resolves instantly there.
 */
function DisclosureWrapper({
  anim,
  delay,
  railDepth = 0,
  children,
}: {
  anim: "in" | "out" | null;
  delay: number;
  /**
   * Ancestor depth whose indent rails belong to this row (MYND-622).
   *
   * The rails are drawn HERE, on the wrapper's outer box, rather than inside the
   * row. Each rail overhangs its row by `ROW_GAP` px so it meets the next row's
   * rail and the tree reads as one continuous line down a sibling group — but
   * the inner box clips to `overflow: hidden` while a disclosure animates, which
   * cut exactly that overhang off. Every expand/collapse therefore shredded the
   * tree lines into per-row dashes, worst on a deep tree where the most rails
   * are in flight at once. The outer box never clips, so the rails survive.
   *
   * `0` renders nothing (root rows have no ancestors).
   */
  railDepth?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(anim !== "in");
  useLayoutEffect(() => {
    if (anim === null) {
      setOpen(true);
      return;
    }
    // Paint the resting "from" state (in → closed, out → open), then flip to the
    // target on the next frame so the property change actually transitions.
    setOpen(anim === "out");
    const frame = requestAnimationFrame(() => setOpen(anim !== "out"));
    return () => cancelAnimationFrame(frame);
  }, [anim]);

  const animating = anim !== null;
  const easing = anim === "in" ? "var(--ease-out)" : "var(--ease-standard)";
  return (
    <div
      style={{
        display: "grid",
        // Anchors the indent rails below, which must sit outside the clipped
        // inner box (see `railDepth`).
        position: "relative",
        gridTemplateRows: open ? "1fr" : "0fr",
        // Bound the single column to the container (min 0 = shrinkable below the
        // row's content, max 1fr = fill). Without this the implicit `auto` column
        // grows to a long note title's max-content, so the row (and its hover /
        // active pill) overflowed the sidebar under the editor. With it, the row
        // is constrained and the title ellipsizes.
        gridTemplateColumns: "minmax(0, 1fr)",
        minWidth: 0,
        opacity: open ? 1 : 0,
        transition: animating
          ? `grid-template-rows var(--duration-base) ${easing} ${delay}ms, opacity var(--duration-base) ${easing} ${delay}ms`
          : undefined,
        willChange: animating ? "grid-template-rows, opacity" : undefined,
      }}
    >
      <TreeRails depth={railDepth} />
      <div style={{ minHeight: 0, minWidth: 0, overflow: animating ? "hidden" : "visible" }}>
        {children}
      </div>
    </div>
  );
}

type ContextMenuState = { id: NoteId; x: number; y: number } | null;

/**
 * A folder as the MOVE pickers need it (myne#952): the canonical path (the value
 * the move writes and the menu's `data-item-id`), the bare name, and the tree
 * depth the picker indents by. Derived in one depth-first walk of the same
 * derived tree the sidebar renders, so the picker cannot disagree with it about
 * what contains what.
 */
type FolderChoice = { path: string; name: string; depth: number };

function PopulatedList({
  rows,
  favRows,
  navIds,
  treeAnimRows,
  folderChoices,
  folderIndexRoles,
  folderIndexByKey,
  onToggleFolder,
  onRevealFolder,
  onCreate,
  fm,
  exportHooks,
  showTimestamps,
}: {
  rows: VisibleRow[];
  favRows: VisibleRow[];
  navIds: NoteId[];
  /** Folder choices for the two move pickers (myne#952): bare name + tree depth,
   *  so the picker can render them as a collapsible tree rather than a flat list
   *  of space-indented labels. Kept separate from `NoteList.folderOptions`, which
   *  is the FilterBuilder's indented-label shape. */
  folderChoices: readonly FolderChoice[];
  /** Note-id → folder-index role (MYND-370): "index" = the folder's index note,
   *  "conflict" = a claimant that lost the tiebreak. Drives the NoteRow badge +
   *  conflict indicator. Computed in the parent off the derived tree. */
  folderIndexRoles: ReadonlyMap<NoteId, "index" | "conflict">;
  /** Folder-key → its index note id (MYND-370). Drives the single-folder-note
   *  guard: the per-note "Set as folder note" action is offered only when the
   *  note's folder is absent from this map. Computed in the parent off the tree. */
  folderIndexByKey: ReadonlyMap<string, NoteId>;
  /** Per-row folder disclosure-animation descriptors, keyed by VirtualList row
   *  key (empty when no expand/collapse is animating). Computed in the parent so
   *  it shares `treeAnim` state with the toggle handler; each entry's `mode` +
   *  `delay` drive that row's `DisclosureWrapper`. */
  treeAnimRows: ReadonlyMap<string, { mode: "in" | "out"; delay: number }>;
  onToggleFolder: (key: string) => void;
  /** Open a folder + its ancestors so a child created inside it (new note or
   *  subfolder) is visible under the default-collapsed tree. Owned by the parent
   *  (mutates the shared expansion state alongside `onToggleFolder`). */
  onRevealFolder: (path: string) => void;
  onCreate: () => void;
  fm: FolderManagement;
  exportHooks?: NoteExportUiHooks;
  /** Sidebar per-note timestamp visibility (sidebar-note-timestamps), read from
   *  `PrefsView.show_note_timestamps` in the parent. Threaded into every
   *  `<NoteRow>` (tree + Favorites) via `renderNoteRow`. */
  showTimestamps: boolean;
}) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();

  // The tree container (myne-md/myne#728): the roving tabindex's fallback Tab
  // stop, and the element focus is tracked against when the selection moves.
  const treeRef = useRef<HTMLDivElement | null>(null);

  // Focus follows the selection, but ONLY while focus is already inside the
  // tree. That condition is the whole of it: the arrow handler is bound at
  // document level and a selection also changes when a note is opened from the
  // palette, from a wikilink, or from a click, and stealing focus into the
  // sidebar on any of those would pull the user out of whatever they were
  // typing in. Inside the tree, though, a selection that moves without focus
  // moving leaves the ring behind on the previous row and the next Tab leaves
  // from the wrong place.
  useEffect(() => {
    const tree = treeRef.current;
    if (tree === null || ctx.selectedId === null) return;
    const active = document.activeElement;
    if (active === null || !tree.contains(active)) return;
    // By id rather than by a query, so the row and this lookup cannot disagree
    // about how a row is addressed; `getElementById` also sidesteps escaping a
    // note id into a CSS selector. The id is section-scoped, so this asks for
    // the TREE copy specifically: a favourited note also has a Favorites copy
    // earlier in the document, and an unscoped lookup used to return that one
    // and then fail the containment check below, so focus never followed the
    // selection for any pinned note.
    const row = document.getElementById(noteRowDomId(ctx.selectedId, "tree"));
    // Absent means the row is virtualized out; the container keeps the focus
    // in that case rather than the focus being dropped on the document.
    if (row !== null && row !== active && tree.contains(row)) row.focus();
  }, [ctx.selectedId]);

  // Whether a ROW currently carries the list's Tab stop. Measured from the
  // DOM rather than predicted from state, because the three ways it can be
  // false are a pref (`noteHighlightActive`), a virtualizer window and a
  // section split, and a predicate over all three drifts from the rows the
  // moment any of them changes. A stale `false` costs one redundant Tab stop
  // for a frame, a stale `true` costs the whole list: the container holds
  // `tabIndex={-1}` believing a row has the stop, the row is gone, and the
  // sidebar has no Tab stop at all.
  //
  // Driven by a MutationObserver rather than by this component's render
  // cadence, and the review of this pass is why. A bare `useEffect` with no
  // dependency array runs when THIS component renders, and the thing it
  // measures is mounted by `VirtualList`, which re-renders on scroll from its
  // own internal state without re-rendering us. So an ordinary scroll that
  // pushed the selected row out of the window left `treeOwnsTabStop` true
  // over a tree with no `tabindex="0"` in it, which is exactly the
  // whole-list-loses-its-Tab-stop case above, reachable by turning a wheel.
  // The observer watches the thing that actually changes: rows entering and
  // leaving the subtree, and `tabindex` moving between them.
  const treeOwnsTabStop = useRowOwnsTabStop(treeRef);

  // The selection announcement (myne-md/myne#728, story 11). Moving the
  // selection with the arrows changes what the editor shows and paints a new
  // row, and neither of those reaches a screen reader: focus moves between
  // rows whose names are read, but the note that OPENED as a result is a
  // separate event the user has to re-orient to find. A polite region states
  // it once per move.
  const selectedTitle =
    ctx.selectedId === null ? null : (ctx.cache.get(ctx.selectedId)?.title ?? null);

  // The tree's own keyboard handler. Rebuilt whenever its inputs move; the
  // rows are read from the DOM at press time rather than captured, because the
  // virtualizer mounts and unmounts them under us and a captured list would
  // name elements that have left the document.
  // Trap + restore focus while the case-merge confirm dialog is open (MYND-93).
  const caseMergeDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(caseMergeDialogRef, { enabled: fm.caseMerge !== null });
  // Archive-feature disable toggle (archive-disable, MYND-…): hides the archive
  // context-menu actions when on. `usePrefs` is nonce-aware, so flipping the
  // Settings toggle re-renders the menu live. (Read here rather than threaded as
  // a prop — same independent-`usePrefs` pattern as the parent sidebar list.)
  const { prefs: rowPrefs } = usePrefs();
  const archiveDisabled = rowPrefs.archive_disabled ?? false;
  // Folder-notes feature gate (myne-md/myne#661): read here (same independent-
  // `usePrefs` pattern as `archiveDisabled` above) so a Settings toggle hides or
  // reveals the folder-note entry points live. When off, the create/set-index
  // affordances are suppressed; the parent's `deriveFolderTree` already leaves
  // `indexNoteId` null, so the open/remove variants never render regardless.
  const folderNotesEnabled = rowPrefs.folder_notes_enabled;
  // SYNC-9 exclusive active-state (MYND-164): opening a note from the sidebar
  // returns the center pane to the editor. The `selectedId`-keyed effect in
  const ws = useWorkspace();
  // Open a note from the sidebar into the workspace (MYND-166). Modifiers /
  // context-menu choose the target: Alt → split to the side; Cmd/Ctrl or
  // middle → new tab; plain → reuse the focused tab. The editor mirrors the
  // focused pane's active note back into `selectedId` for row highlight
  // (Editor.tsx bridge B). No-op fallback outside the providers.
  //
  // The `setView("editor")` that used to open this function is gone with the
  // center-view mechanism (myne-md/myne#773): opening a note in the focused
  // pane IS the way back from any non-note tab, including the re-click-the-
  // already-selected-note edge the `selectedId` effect could never see.
  const openNote = useCallback(
    (id: NoteId, opts?: { newTab?: boolean; toSide?: boolean }) => {
      // Plain click → open in the focused pane's CURRENT active tab (reuse);
      // Cmd/Ctrl-click (or middle) → a new tab; Alt-click → split to the
      // side. Re-opening an already-open note reveals it (duplicate-forbid).
      if (opts?.toSide) ws.openToSide(id);
      else if (opts?.newTab) ws.openNewTabInFocused(id);
      else ws.openInFocused(id);
    },
    [ws],
  );
  // Exclusive active-state (MYND-164 Fix 1, generalised by myne-md/myne#773):
  // a sidebar note row renders its selected highlight only while the focused
  // tab IS a note. The selection stays in `ctx.selectedId`, so returning to the
  // note restores it; it just is not SHOWN as active meanwhile.
  //
  // The old rule asked whether the attachment library owned the center pane,
  // which was the only non-note surface that could — so it was correct for the
  // library and WRONG for the graph and the task list, which could both be
  // focused while a note row still claimed to be active.
  //
  // Asked of the registry rather than compared to the literal `"note"`: the
  // top-right floats ask the identical question one file over, and a literal in
  // each is how the two drifted in the first place.
  const activeKind = ws.focusedLeaf.activeTab?.kind;
  const noteHighlightActive =
    activeKind !== undefined && tabKindSpec(activeKind).showsFocusedNote;

  const onTreeKeyDown = useMemo(
    () =>
      makeTreeKeydownHandler({
        rowsOf: () =>
          treeRef.current === null
            ? []
            : Array.from(
                treeRef.current.querySelectorAll<HTMLElement>('[role="treeitem"]'),
              ),
        select: ctx.select,
        open: (id) => openNote(id),
        toggleFolder: onToggleFolder,
        renaming: ctx.renamingId !== null,
      }),
    [ctx.select, ctx.renamingId, openNote, onToggleFolder],
  );

  // The Favorites tree's own keyboard, which it did not have (myne#728,
  // found in review). The block is declared `role="tree"` because its rows
  // are `treeitem`s and a treeitem with no tree ancestor is invalid ARIA, but
  // declaring the role was only half of it: the container carried no
  // `tabIndex` and no `onKeyDown`, and `NoteRow` gives the roving Tab stop to
  // the TREE copy of a favourited note and never to the Favorites one, so
  // every row here was `-1` too. The result announced a tree to a screen
  // reader that no keyboard could enter, by Tab, by F6 or by arrows, which is
  // worse than the `aria-required-parent` it was added to fix.
  //
  // Its container is unconditionally the Tab stop, unlike the main tree's
  // measured `treeOwnsTabStop`: no Favorites row can ever own one, by that
  // same deliberate rule, so there is nothing to measure.
  const favTreeRef = useRef<HTMLDivElement | null>(null);
  const onFavTreeKeyDown = useMemo(
    () =>
      makeTreeKeydownHandler({
        rowsOf: () =>
          favTreeRef.current === null
            ? []
            : Array.from(
                favTreeRef.current.querySelectorAll<HTMLElement>('[role="treeitem"]'),
              ),
        select: ctx.select,
        open: (id) => openNote(id),
        // Flat by construction: a favourite is a note, never a folder, so the
        // horizontal pair has nothing to expand here.
        toggleFolder: () => {},
        renaming: ctx.renamingId !== null,
      }),
    [ctx.select, ctx.renamingId, openNote],
  );

  // Row activation intent router (MYND-166 open modifiers + MYND-367 multi-
  // select). Toggle / range gestures only mutate the selection SET (they never
  // open — see `SidebarState.selectedIds`); every open action first collapses
  // the set back to a single selection so the editor and the highlight agree.
  const activateRow = useCallback(
    (
      id: NoteId,
      opts?: {
        newTab?: boolean;
        toSide?: boolean;
        toggle?: boolean;
        range?: boolean;
      },
    ) => {
      if (opts?.range) {
        // Range pivots on anchorId ?? selectedId ?? target, so a plain-click
        // selection is already included as the anchor (no seeding needed).
        ctx.selectRange(navIds, id);
        return;
      }
      if (opts?.toggle) {
        // Seed the set with the currently-open note when starting a fresh
        // multi-selection (Finder intuition: click A, cmd-click B → {A, B}).
        // selectedId is the open-bridge surface; fold it into the bulk set so
        // the open note isn't silently excluded from the operation.
        if (
          ctx.selectedIds.size === 0 &&
          ctx.selectedId !== null &&
          ctx.selectedId !== id
        ) {
          ctx.replaceSelection([ctx.selectedId, id]);
        } else {
          ctx.toggleInSelection(id);
        }
        return;
      }
      ctx.clearMultiSelection();
      openNote(id, opts);
    },
    [ctx, navIds, openNote],
  );
  const [menu, setMenu] = useState<ContextMenuState>(null);
  // Bulk "Move N notes to…" target submenu anchor (MYND-367) — opened from the
  // bulk context menu, lists folder options + Vault root.
  // The move picker acts on an EXPLICIT id set carried on the target (MYND-622).
  // It used to read the multi-selection at commit time, which was fine while
  // "Move to…" existed only in the bulk menu; the single-note entry needs to move
  // the row that was right-clicked, which is not necessarily selected at all.
  const [moveTarget, setMoveTarget] = useState<{
    x: number;
    y: number;
    ids: NoteId[];
  } | null>(
    null,
  );
  // myne#281 — the folder equivalent. Separate state because the payload is a
  // folder node, not a note-id set, and the two pickers offer different targets
  // (a folder cannot be offered itself or its own descendants).
  const [folderMoveTarget, setFolderMoveTarget] = useState<{
    x: number;
    y: number;
    node: FolderNode;
  } | null>(null);
  // Undo target for a bulk trash (MYND-367) — the ids just moved to Trash, so
  // "Undo" can restore the whole set (parity with the single-note undo toast).
  const [bulkUndo, setBulkUndo] = useState<readonly NoteId[] | null>(null);
  // Undo-toast target: the id of the note just moved to the trash. "Undo"
  // restores it (MYND-133). Replaced when another note is trashed.
  const [undoToast, setUndoToast] = useState<NoteId | null>(null);
  // Summary of the last drag-drop markdown import (MYND-629).
  const [importToast, setImportToast] = useState<string | null>(null);

  /**
   * Import markdown files dropped onto a folder row. Reports a count rather
   * than per-file detail: a drop of twenty should not produce twenty toasts,
   * and the skip reasons are coarse by design (an underlying error can carry a
   * filesystem path, which must not reach the UI).
   */
  const handleDropFiles = useCallback(
    async (folderPath: string, files: File[]) => {
      if (!files.some((f) => /\.(md|markdown|mdown|txt)$/i.test(f.name))) {
        setImportToast(t("notes.list.importNoMarkdown"));
        return;
      }
      const result = await importDroppedMarkdown(files, folderPath);
      // Same create-then-refresh discipline the folder-note path uses: pull the
      // real slice for each new id rather than assuming the list will notice.
      for (const id of result.created) await ctx.refreshOne(id);
      setImportToast(
        result.skipped.length === 0
          ? t("notes.list.imported", { count: result.created.length })
          : t("notes.list.importedWithSkips", {
              count: result.created.length,
              skipped: result.skipped.length,
            }),
      );
    },
    [ctx, t],
  );
  // Non-blocking error toast shown when a trash IPC fails after rollback.
  const [trashError, setTrashError] = useState<string | null>(null);
  // Confirmation gate for the keyboard Delete/Backspace path (MYND-487). An
  // accidental keypress must not silently soft-trash the selection, so the
  // keydown handler stages the victim(s) here and a DeleteConfirmModal
  // confirms before `handleTrash` / `handleBulkDelete` runs. Context-menu
  // Delete keeps its immediate + undo-toast behaviour (a deliberate click).
  const [confirmKeyboardDelete, setConfirmKeyboardDelete] = useState<
    | { kind: "single"; id: NoteId }
    | { kind: "bulk"; ids: readonly NoteId[] }
    | null
  >(null);
  // Right-click on the sidebar background (not a row) → root-level menu
  // ("New folder" / "New note"). Story F2. A row's own context-menu handler
  // calls `preventDefault`, so we bail when the event was already handled.
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null);
  const handleBackgroundContextMenu = useCallback((e: MouseEvent) => {
    if (e.defaultPrevented) return; // a note / folder row already handled it
    e.preventDefault();
    setBgMenu({ x: e.clientX, y: e.clientY });
  }, []);
  // Click on the empty sidebar background → drop the multi-selection (MYND-367).
  // A click that landed on a note/folder row or inside an open menu is handled
  // by that surface (a row's own activation already collapses or extends the
  // set), so skip those — only a genuine empty-space click clears.
  const handleBackgroundClick = useCallback(
    (e: MouseEvent) => {
      if (ctx.selectedIds.size === 0) return;
      const el = e.target as HTMLElement | null;
      if (
        el !== null &&
        el.closest(
          '[data-testid="notes.row"],[data-testid="notes.folder-row"],[role="menu"]',
        ) !== null
      ) {
        return;
      }
      ctx.clearMultiSelection();
    },
    [ctx],
  );
  const closeBgMenu = useCallback(() => setBgMenu(null), []);
  // Decoration picker (MYND-184 color labels / MYND-185 folder icons) — an
  // anchored popover opened from a flat "Color…" / "Customize…" context-menu
  // item (so ContextMenu itself stays lean). `folderPath` is set for a folder
  // (the icon section keys on it, MYND-185), null for a note (color only).
  const [decoPopover, setDecoPopover] = useState<{
    x: number;
    y: number;
    key: string;
    folderPath: string | null;
  } | null>(null);
  const closeDecoPopover = useCallback(() => setDecoPopover(null), []);

  const handleContextMenu = useCallback(
    (id: NoteId, pos: { x: number; y: number }) => {
      // Do NOT select the right-clicked row. Under the MYND-166 workspace
      // model a selection change drives Editor.tsx's bridge A, which OPENS
      // the note in the focused pane — so a Finder-style "right-click also
      // selects" would open the note on every right-click and, worse, leave
      // it already-open so "Open in new tab" degrades to a reveal. Right-
      // click only surfaces the menu; every menu item already acts on
      // `menu.id`, not the selection.
      setMenu({ id, x: pos.x, y: pos.y });
    },
    [],
  );

  // Favorite-membership lookup — one Set shared by the tree rows + the context
  // menu (avoids a per-row `favorites.includes` array scan).
  const favSet = useMemo(() => new Set(fm.favorites), [fm.favorites]);

  // Per-note "not yet on the server" (phase3-web-client task 23). Read here
  // rather than inside `<NoteRow>` so one poll serves the whole list — a hook
  // per row would issue one IPC call per visible note on every tick.
  const { unsyncedIds } = useUnsyncedEdits();

  // Shared <NoteRow> renderer — the Favorites section and the tree render an
  // identical NoteRow (only the `favorited` flag + the surrounding drag wrapper
  // differ). Keeping the prop wiring in one place stops the two sites drifting.
  const renderNoteRow = useCallback(
    (
      record: TitleRecord,
      id: NoteId,
      favorited: boolean,
      hierarchy?: { level: number; posInSet: number; setSize: number },
      // Which SECTION is rendering it (myne-md/myne#728). A favourited note is
      // rendered twice, and the two copies must not share a DOM id or a Tab
      // stop.
      section: NoteRowSection = "tree",
    ) => {
      const role = folderIndexRoles.get(id);
      return (
        <NoteRow
          record={record}
          hierarchy={hierarchy}
          section={section}
          selected={noteHighlightActive && ctx.selectedId === id}
          multiSelected={noteHighlightActive && ctx.selectedIds.has(id)}
          renaming={ctx.renamingId === id}
          onSelect={(noteId, opts) => activateRow(noteId, opts)}
          onStartRename={ctx.startRename}
          onContextMenu={handleContextMenu}
          onCommitRename={async (noteId, newTitle) => {
            // The inline title rename inherits the same refusal the folder
            // rename does: `commitRename` awaits `flushOpenPanes()` whenever an
            // inbound note is open, rolls the optimistic rename back and
            // rethrows. Without this the user watches the title flip to the new
            // value and silently flip back, with the only other trace an
            // unhandled rejection in the console. Same message as the folder
            // path's, because it is the same fact about the same pane.
            //
            // Anything else gets the generic sentence rather than a rethrow:
            // the prop is typed `=> void` and the caller discards the promise,
            // so a rethrow here is an unhandled rejection and a title that
            // reverted for no stated reason. The rollback has already run in
            // `commitRename`, so both arms are true.
            try {
              await executeRenameCommit(noteId, newTitle, ctx);
            } catch (err) {
              const refused = isPanesNotSettled(err);
              setTrashError(
                panesNotSettledMessage(err, {
                  unsettled: t("notes.unsettledSave"),
                  failed: t("notes.list.renameFailed"),
                }),
              );
              if (import.meta.env.DEV && !refused) {
                // eslint-disable-next-line no-console
                console.warn("[NoteList] rename failed:", err);
              }
            }
          }}
          onCancelRename={ctx.cancelRename}
          favorited={favorited}
          onToggleFavorite={fm.toggleFavorite}
          colorSlot={fm.itemColors[id]}
          showTimestamps={showTimestamps}
          isIndexNote={role === "index"}
          indexConflict={role === "conflict"}
          unsynced={unsyncedIds.has(id)}
          showTaskMarker={rowPrefs.show_task_marker}
        />
      );
    },
    [
      ctx,
      activateRow,
      handleContextMenu,
      fm.toggleFavorite,
      noteHighlightActive,
      fm.itemColors,
      showTimestamps,
      folderIndexRoles,
      unsyncedIds,
      rowPrefs.show_task_marker,
    ],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  // Move a note to the trash (MYND-133). Reversible — no confirmation modal;
  // an undo toast offers immediate restore. If the trashed note was open, move
  // selection to an adjacent row (or clear it) so the editor doesn't dwell on a
  // note that just left the live tree. `pickAdjacentAfterDelete` runs against
  // the pre-trash nav list (the victim is still live at click time).
  const handleTrash = useCallback(
    async (id: NoteId) => {
      const wasSelected = ctx.selectedId === id;
      const adjacent = wasSelected ? pickAdjacentAfterDelete(navIds, id) : null;
      setMenu(null);
      try {
        await ctx.trashWithRollback(id);
        // Close the note's tabs in every pane (#219): it left the live tree, so
        // no stale, still-editable buffer may remain — an autosave of it would
        // silently write the note back out of the trash.
        ws.closeNoteEverywhere(id);
        setUndoToast(id);
        if (wasSelected) {
          if (adjacent !== null) {
            void ctx.open(adjacent).catch(() => {
              /* editor body load failure surfaces via its own UX */
            });
          } else {
            ctx.select(null);
          }
        }
      } catch (err) {
        // Rollback already restored the row inside trashWithRollback; surface
        // a non-blocking error so the user knows it didn't take.
        setTrashError(t("notes.list.trashSingleError"));
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] trashWithRollback failed:", err);
        }
      }
    },
    [ctx, navIds, t, ws],
  );

  // Archive a single note (MYND-331): optimistically pull it from the live tree
  // (archiveWithRollback sets `archived:` + clears any `trashed:`), move the
  // editor to an adjacent row if the archived note was open. Mirrors
  // `handleTrash` minus the undo toast — the note is recoverable from the
  // Archive section, not a transient undo.
  const handleArchive = useCallback(
    async (id: NoteId) => {
      const wasSelected = ctx.selectedId === id;
      const adjacent = wasSelected ? pickAdjacentAfterDelete(navIds, id) : null;
      setMenu(null);
      try {
        await ctx.archiveWithRollback(id);
        // Same as trash (#219): archiving takes the note out of the live tree, so
        // close its tabs — a stale buffer autosaved back would drop `archived:`.
        ws.closeNoteEverywhere(id);
        if (wasSelected) {
          if (adjacent !== null) {
            void ctx.open(adjacent).catch(() => {
              /* editor body load failure surfaces via its own UX */
            });
          } else {
            ctx.select(null);
          }
        }
      } catch (err) {
        setTrashError(t("notes.list.archiveSingleError"));
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] archiveWithRollback failed:", err);
        }
      }
    },
    [ctx, navIds, t, ws],
  );

  // "Undo" on the trash toast → restore the just-trashed note.
  const handleUndoTrash = useCallback(() => {
    if (undoToast === null) return;
    const id = undoToast;
    setUndoToast(null);
    void ctx.restoreWithRollback(id).catch((err) => {
      // `restoreNote` now flushes dirty panes first and rejects when one does
      // not settle (myne-md/myne#819). That rejection is user-reachable, so it
      // gets the same non-blocking message the trash path shows rather than a
      // DEV-only log.
      setTrashError(t("notes.trash.restoreError"));
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[NoteList] restore (undo) failed:", err);
      }
    });
  }, [undoToast, ctx, t]);

  // ---- folder notes (MYND-370) -------------------------------------------
  // Create a new index note for `folderPath`, settle it into the cache (so the
  // new row + its badge appear), then open it in the focused pane. Mirrors the
  // `newNoteHere` create-then-refresh discipline; `createFolderNote` mints the
  // note via the same `note_create` IPC, so `refreshOne` pulls the real slice.
  const handleCreateFolderNote = useCallback(
    async (folderPath: string) => {
      try {
        const newId = await createFolderNote(folderPath);
        await ctx.refreshOne(newId);
        openNote(newId);
      } catch (err) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] createFolderNote failed:", err);
        }
      }
    },
    [ctx, openNote],
  );

  // Open a folder's existing index note — the same open path a note-row click
  // uses (reuse the focused pane).
  const handleOpenIndexNote = useCallback(
    (noteId: NoteId) => openNote(noteId),
    [openNote],
  );

  // Double-click a folder row: open its folder note, or create one if it has
  // none (MYND-370). The single creation path — gated on `indexNoteId === null`
  // here and in the affordance/menu — is what keeps it to exactly one per folder.
  const handleFolderActivate = useCallback(
    (node: FolderNode) => {
      if (node.indexNoteId !== null) handleOpenIndexNote(node.indexNoteId);
      // With folder notes off, a double-click must not mint one (myne-md/myne#661).
      // `indexNoteId` is already null in that mode, so this guard is what stops
      // the create branch from firing.
      else if (folderNotesEnabled) void handleCreateFolderNote(node.path);
    },
    [handleOpenIndexNote, handleCreateFolderNote, folderNotesEnabled],
  );

  // Designate / undesignate a note as its folder's index, then settle the write.
  // The flag flip writes through the dedicated `folderNote` orchestrators (no
  // `updated:` bump) straight to disk, and `refreshOne` alone re-reads only the
  // sidebar slice: an open note's pane keeps the pre-write bytes and its next
  // autosave writes them back, reverting the field the user just set.
  // `settleFrontmatterWrite` is the recipe for that half (its own header names
  // this failure) and it reloads the pane and refreshes the record together.
  //
  // It is the CLEAN-pane half only, deliberately. The other half is the flush
  // before the write, and `flushBeforeFrontmatterWrite.ts` lists `folderNote`
  // among the five writers that do NOT flush, each needing its own answer:
  // inheriting that rejection would make this action fail while a save is
  // failing elsewhere. So a DIRTY pane still races: the reload early-returns on
  // pending work, and the writers' read-patch-write can lose the field or mint a
  // keep-both copy. That race is recorded in `decisions/editor/0684` rather than
  // claimed away here.
  const handleSetIndex = useCallback(
    async (id: NoteId) => {
      setMenu(null);
      try {
        await setFolderIndex(id);
        await settleFrontmatterWrite(ctx, id);
      } catch (err) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] setFolderIndex failed:", err);
        }
      }
    },
    [ctx],
  );
  const handleUnsetIndex = useCallback(
    async (id: NoteId) => {
      setMenu(null);
      try {
        await unsetFolderIndex(id);
        // Same settle as the designate above, and it is the half that matters
        // here: the undesignate DELETES the field, so a pane left holding the
        // pre-write frontmatter would write `folder_index: true` back on its
        // next autosave and resurrect a designation the user just removed.
        await settleFrontmatterWrite(ctx, id);
      } catch (err) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] unsetFolderIndex failed:", err);
        }
      }
    },
    [ctx],
  );

  // Bulk move (MYND-367): move the whole multi-selection to `folder` (or root)
  // best-effort, then collapse the set. Reads `selectedIds` at call time (not
  // inside the async closure) so a concurrent clear can't shrink the payload.
  const runBulkMove = useCallback(
    async (folder: string | null, explicitIds?: readonly NoteId[]) => {
      const ids = explicitIds !== undefined ? [...explicitIds] : [...ctx.selectedIds];
      setMoveTarget(null);
      setMenu(null);
      if (ids.length === 0) return;
      try {
        await ctx.bulkMoveWithSync(ids, folder);
      } catch (err) {
        // bulkMoveNotes never rejects (best-effort); guard defensively anyway.
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] bulkMoveWithSync failed:", err);
        }
      }
      ctx.clearMultiSelection();
    },
    [ctx],
  );

  // Bulk trash (MYND-367): soft-trash the whole multi-selection (reversible via
  // the undo toast), then collapse the set. If the OPEN note is among the
  // victims, move the editor to the first surviving nav row (or clear).
  const handleBulkDelete = useCallback(async () => {
    const ids = [...ctx.selectedIds];
    setMenu(null);
    if (ids.length === 0) return;
    const victims = new Set(ids);
    const openIsVictim =
      ctx.selectedId !== null && victims.has(ctx.selectedId);
    const survivor = openIsVictim
      ? (navIds.find((nid) => !victims.has(nid)) ?? null)
      : null;
    try {
      const result = await ctx.bulkTrashWithSync(ids);
      // Close every trashed note's tabs (myne-md/myne#819): the single-note path
      // above does, and a stale still-editable buffer autosaved back would
      // resurrect the note. Only the ones that actually trashed.
      for (const id of result.trashed) ws.closeNoteEverywhere(id);
      setBulkUndo(ids);
      if (openIsVictim) {
        if (survivor !== null) {
          void ctx.open(survivor).catch(() => {
            /* editor body load failure surfaces via its own UX */
          });
        } else {
          ctx.select(null);
        }
      }
    } catch (err) {
      setTrashError(t("notes.list.trashBulkError"));
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[NoteList] bulkTrashWithSync failed:", err);
      }
    }
    ctx.clearMultiSelection();
  }, [ctx, navIds, t, ws]);

  // Bulk archive (MYND-331 / MYND-367): archive the whole multi-selection
  // (recoverable from the Archive section), then collapse the set. If the OPEN
  // note is among them, move the editor to the first surviving nav row.
  const handleBulkArchive = useCallback(async () => {
    const ids = [...ctx.selectedIds];
    setMenu(null);
    if (ids.length === 0) return;
    const victims = new Set(ids);
    const openIsVictim =
      ctx.selectedId !== null && victims.has(ctx.selectedId);
    const survivor = openIsVictim
      ? (navIds.find((nid) => !victims.has(nid)) ?? null)
      : null;
    try {
      const result = await ctx.bulkArchiveWithSync(ids);
      // Same as the single-note archive path (myne-md/myne#819): archiving takes
      // the notes out of the live tree, so close their tabs — a stale buffer
      // autosaved back would drop `archived:`. Only the ones that archived.
      for (const id of result.archived) ws.closeNoteEverywhere(id);
      if (openIsVictim) {
        if (survivor !== null) {
          void ctx.open(survivor).catch(() => {
            /* editor body load failure surfaces via its own UX */
          });
        } else {
          ctx.select(null);
        }
      }
    } catch (err) {
      setTrashError(t("notes.list.archiveBulkError"));
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[NoteList] bulkArchiveWithSync failed:", err);
      }
    }
    ctx.clearMultiSelection();
  }, [ctx, navIds, t, ws]);

  // "Undo" on the bulk-trash toast → restore every just-trashed note.
  const handleUndoBulk = useCallback(() => {
    const ids = bulkUndo;
    setBulkUndo(null);
    if (ids === null) return;
    // `allSettled` never rejects, so a `.catch` here was dead code and every
    // per-note failure was dropped. Each `restoreNote` now flushes first and can
    // reject (myne-md/myne#819); inspect the results and report any failure.
    void Promise.allSettled(ids.map((id) => ctx.restoreWithRollback(id))).then(
      (results) => {
        if (results.some((r) => r.status === "rejected")) {
          setTrashError(t("notes.trash.restoreError"));
        }
      },
    );
  }, [bulkUndo, ctx, t]);

  // Bulk "Move N notes to…" picker: Vault root + every folder as a collapsible
  // tree (myne#952). Folder path is the item id → addressable by `data-item-id`
  // in E2E.
  const moveMenuItems: ContextMenuItem[] = useMemo(
    () => [
      {
        id: "__vault_root__",
        label: t("notes.list.vaultRoot"),
        icon: "folder",
        depth: 0,
        onSelect: () => void runBulkMove(null, moveTarget?.ids),
      },
      ...folderChoices.map((o) => ({
        id: o.path,
        label: o.name,
        path: o.path,
        depth: o.depth,
        icon: "folder" as const,
        onSelect: () => void runBulkMove(o.path, moveTarget?.ids),
      })),
    ],
    [folderChoices, runBulkMove, moveTarget, t],
  );

  // myne#281 — "Move folder to…": Vault root + every folder that is not the
  // dragged folder itself nor one of its own descendants. Filtering the list is
  // not the guard (`moveFolderTo` still refuses), it is what keeps the menu from
  // offering a destination it would then reject.
  const folderMoveMenuItems: ContextMenuItem[] = useMemo(() => {
    const node = folderMoveTarget?.node;
    if (node === undefined) return [];
    const selfKey = foldSegment(node.path);
    return [
      {
        id: "__vault_root__",
        label: t("notes.list.vaultRoot"),
        icon: "folder",
        depth: 0,
        onSelect: () => void fm.moveFolderTo(node, null),
      },
      ...folderChoices
        .filter((o) => !foldSegment(o.path).startsWith(selfKey))
        .map((o) => ({
          id: o.path,
          label: o.name,
          path: o.path,
          depth: o.depth,
          icon: "folder" as const,
          onSelect: () => void fm.moveFolderTo(node, o.path),
        })),
    ];
  }, [folderChoices, folderMoveTarget, fm, t]);

  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (menu === null) return [];
    // Bulk mode: the right-clicked row is part of a multi-selection of >1 — the
    // menu acts on the whole set, not the single row under the cursor (MYND-367).
    const selCount = ctx.selectedIds.size;
    if (selCount > 1 && ctx.selectedIds.has(menu.id)) {
      return [
        {
          id: "bulk-move",
          group: "organize",
          icon: "folder" as const,
          label: t("notes.list.bulkMove", { count: selCount }),
          onSelect: () =>
            setMoveTarget({ x: menu.x, y: menu.y, ids: [...ctx.selectedIds] }),
        },
        // Archiving disabled → no "archive these" entry (the feature is hidden).
        ...(archiveDisabled
          ? []
          : [
              {
                id: "bulk-archive",
                group: "danger",
                icon: "archive" as const,
                label: t("notes.list.bulkArchive", { count: selCount }),
                onSelect: () => void handleBulkArchive(),
              },
            ]),
        {
          id: "bulk-delete",
          group: "danger",
          icon: "trash-2" as const,
          label: t("notes.list.bulkDelete", { count: selCount }),
          destructive: true,
          onSelect: () => void handleBulkDelete(),
        },
      ];
    }
    return [
      {
        id: "open-in-new-tab",
        group: "open",
        icon: "maximize-2",
        label: t("notes.list.openInNewTab"),
        onSelect: () => openNote(menu.id, { newTab: true }),
      },
      {
        id: "open-to-side",
        group: "open",
        icon: "columns-2",
        label: t("notes.list.openToSide"),
        onSelect: () => openNote(menu.id, { toSide: true }),
      },
      {
        // MYND-622: desktop parity with mobile's folder context menu (MYND-480),
        // which has had "Move to folder" since it shipped. Dragging was the only
        // way to move a single note here, which is unreachable when the target
        // folder is collapsed or off-screen.
        id: "move",
        group: "organize",
        icon: "folder",
        label: t("notes.list.moveTo"),
        onSelect: () => setMoveTarget({ x: menu.x, y: menu.y, ids: [menu.id] }),
      },
      {
        id: "rename",
        group: "edit",
        icon: "pencil",
        label: t("notes.list.rename"),
        onSelect: () => ctx.startRename(menu.id),
      },
      {
        // Clone the note in place (MYND-332) — new id + "(kopya)" title;
        // the copy opens in the focused pane.
        id: "duplicate",
        group: "edit",
        icon: "copy",
        label: t("notes.list.duplicate"),
        onSelect: () => void ctx.duplicateAndOpen(menu.id),
      },
      {
        id: "favorite",
        group: "edit",
        icon: "bookmark",
        label: favSet.has(menu.id)
          ? t("notes.list.removeFromFavorites")
          : t("notes.list.addToFavorites"),
        onSelect: () => fm.toggleFavorite(menu.id),
      },
      // Folder note (MYND-370): promote this note to its folder's index note —
      // offered ONLY for an in-folder note whose folder has NO index note yet, so
      // a second one can never be designated (exactly one per folder). The "Remove
      // as folder note" inverse is NOT here: the index note is hidden from the tree
      // (its row is unreachable), so undesignate lives on the FOLDER menu instead.
      ...(() => {
        // Suppressed entirely when the folder-notes feature is off (myne-md/myne#661).
        if (!folderNotesEnabled) return [];
        const rec = ctx.cache.get(menu.id);
        if (rec?.folder == null) return [];
        if (folderIndexByKey.get(folderKey(rec.folder)) != null) return [];
        return [
          {
            id: "note.set-index",
            group: "edit",
            icon: "file-text" as const,
            label: t("notes.list.setAsFolderNote"),
            onSelect: () => void handleSetIndex(menu.id),
          },
        ];
      })(),
      {
        id: "color",
        group: "edit",
        icon: "palette",
        label: t("notes.list.color"),
        onSelect: () =>
          setDecoPopover({
            x: menu.x,
            y: menu.y,
            key: menu.id,
            folderPath: null,
          }),
      },
      {
        // Per-note plaintext egress (MYND-116) — live tree note rows only;
        // Trash / Templates surfaces deliberately don't carry it.
        //
        // ONE row with a submenu, where there used to be one row per format.
        // Four of them ran down the middle of a menu that has ten entries, and
        // the same four were spelled out again in the editor's "…" menu. The
        // formats come from `noteExportEntries` now, which is also where the
        // `pdfExport` capability gate moved. The gate used to live here and
        // only here, so the other menu offered PDF on hosts that cannot make
        // one.
        id: "export",
        group: "export",
        icon: "download",
        label: t("notes.export.submenuLabel"),
        // Never called: a row with `children` opens them instead of acting.
        onSelect: () => {},
        children: noteExportEntries(
          menu.id,
          ctx.cache.get(menu.id)?.title ?? null,
          exportHooks,
        ).map((entry) => ({
          id: entry.id,
          label: t(entry.labelKey),
          onSelect: entry.run,
        })),
      },
      // Archive (MYND-331): pull the note out of the working set into the
      // indefinite-retention Archive section. Near Delete, but not destructive.
      // Hidden entirely when archiving is disabled (archive-disable, MYND-…).
      ...(archiveDisabled
        ? []
        : [
            {
              id: "archive",
              group: "danger",
              icon: "archive" as const,
              label: t("notes.list.archiveNote"),
              onSelect: () => void handleArchive(menu.id),
            },
          ]),
      {
        id: "delete",
        group: "danger",
        icon: "trash-2",
        label: t("notes.list.delete"),
        destructive: true,
        onSelect: () => void handleTrash(menu.id),
      },
    ];
  }, [
    menu,
    ctx,
    handleTrash,
    handleArchive,
    handleBulkDelete,
    handleBulkArchive,
    archiveDisabled,
    fm,
    favSet,
    openNote,
    exportHooks,
    folderIndexByKey,
    handleSetIndex,
    folderNotesEnabled,
    t,
  ]);

  // Folder context-menu items (right-click a folder row).
  //
  // Grouped and glyphed (myne#952): a flat run of eight label-only rows gave the
  // eye nothing to land on, and "New subfolder" read as a sibling of "Rename"
  // rather than as the one item that acts on the folder's CONTENTS. The `group`
  // tag draws a divider between runs (organise / create / style / destructive)
  // and the icon column turns each row into something scannable.
  const folderMenuItems: ContextMenuItem[] = useMemo(() => {
    const menuPos = fm.menu;
    const node = menuPos?.node;
    if (node === undefined || menuPos === null) return [];
    return [
      {
        id: "rename",
        group: "organize",
        icon: "pencil",
        label: t("notes.list.rename"),
        onSelect: () => fm.startRenameFolder(node),
      },
      {
        // myne#281 — the note menu has had "Move to…" since MYND-622; the
        // folder menu had no equivalent, so a keyboard or non-drag user had no
        // way to re-nest a folder at all. Same picker, same guards as the drop.
        id: "move",
        group: "organize",
        icon: "arrow-right",
        label: t("notes.list.moveFolderTo"),
        onSelect: () => setFolderMoveTarget({ x: menuPos.x, y: menuPos.y, node }),
      },
      {
        id: "new-note",
        group: "create",
        icon: "file-plus",
        label: t("notes.list.newNoteHere"),
        onSelect: () => {
          onRevealFolder(node.path);
          fm.newNoteHere(node.path);
        },
      },
      {
        id: "new-drawing",
        group: "create",
        icon: "image-plus",
        label: t("notes.list.newDrawingHere"),
        onSelect: () => {
          onRevealFolder(node.path);
          fm.newDrawingHere(node.path);
        },
      },
      // Folder note (MYND-370): open the existing index, or create one; both
      // suppressed entirely when the feature is off (myne-md/myne#661).
      ...(folderNotesEnabled
        ? [
            node.indexNoteId !== null
              ? {
                  id: "folder.open-index",
                  group: "create",
                  icon: "file-text" as const,
                  label: t("notes.list.openFolderNote"),
                  onSelect: () => handleOpenIndexNote(node.indexNoteId as string),
                }
              : {
                  id: "folder.create-index",
                  group: "create",
                  icon: "file-plus" as const,
                  label: t("notes.list.createFolderNote"),
                  onSelect: () => void handleCreateFolderNote(node.path),
                },
          ]
        : []),
      // Undesignate the folder note (MYND-370): the only reachable "remove" path
      // now that the index note is hidden from the tree. Non-destructive — the
      // note returns to an ordinary, visible note (re-appears as a row).
      ...(node.indexNoteId !== null
        ? [
            {
              id: "folder.remove-index",
              group: "create",
              icon: "x" as const,
              label: t("notes.list.removeFolderNote"),
              onSelect: () => void handleUnsetIndex(node.indexNoteId as string),
            },
          ]
        : []),
      {
        id: "new-subfolder",
        group: "create",
        icon: "folder-plus",
        label: t("notes.list.newSubfolder"),
        onSelect: () => {
          onRevealFolder(node.path);
          fm.startNewFolder(node.path);
        },
      },
      {
        id: "color",
        group: "style",
        icon: "palette",
        label: t("notes.list.customize"),
        onSelect: () =>
          setDecoPopover({
            x: menuPos.x,
            y: menuPos.y,
            // Decorations key by the folded folder identity (MYND-562), not the
            // volatile display path — so a color follows the folder across
            // case-variant / display-flip and matches every client.
            key: node.key,
            folderPath: node.key,
          }),
      },
      // Archive the folder as a unit (folder-archive) — hidden when the archive
      // feature is disabled, mirroring the per-note "Archive" gate.
      ...(!archiveDisabled
        ? [
            {
              id: "folder.archive",
              group: "danger",
              icon: "archive" as const,
              label: t("notes.list.archiveFolder"),
              onSelect: () => fm.archiveFolderAction(node),
            },
          ]
        : []),
      {
        id: "delete",
        group: "danger",
        icon: "trash-2",
        label: t("notes.list.delete"),
        destructive: true,
        onSelect: () => void fm.deleteFolderAction(node),
      },
    ];
  }, [
    fm,
    archiveDisabled,
    onRevealFolder,
    handleOpenIndexNote,
    handleCreateFolderNote,
    handleUnsetIndex,
    folderNotesEnabled,
    t,
  ]);

  // Background (root-level) context-menu items — Story F2.
  const bgMenuItems: ContextMenuItem[] = useMemo(
    () => [
      {
        id: "new-folder",
        label: t("notes.list.newFolder"),
        onSelect: () => fm.startNewFolder(""),
      },
      { id: "new-note", label: t("notes.list.newNoteMenu"), onSelect: onCreate },
      {
        id: "new-drawing",
        label: t("notes.list.newDrawingMenu"),
        onSelect: () => void ctx.createDrawingAndStartRename().catch(() => {}),
      },
    ],
    [ctx, fm, onCreate, t],
  );

  // Delete/Backspace keyboard trigger on the selected row.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (ctx.renamingId !== null) return; // don't trigger mid-rename
      // Skip when the event originated in an editable target — text
      // input, textarea, or contenteditable. Otherwise typing inside
      // the editor's body would also pop a delete dialog.
      const target = e.target as HTMLElement | null;
      if (target !== null) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (target.isContentEditable) return;
      }
      // A confirm modal is already open — let it own the keyboard (its own
      // Enter/Esc handlers apply); a repeated Delete press must not re-stage.
      if (confirmKeyboardDelete !== null) return;
      // A multi-selection takes priority — Delete trashes the whole set
      // (MYND-367). Otherwise fall back to the single open note. Either way we
      // only STAGE the victim(s); a DeleteConfirmModal gates the actual trash
      // so a stray keypress can't lose notes (MYND-487).
      if (ctx.selectedIds.size > 0) {
        e.preventDefault();
        setConfirmKeyboardDelete({ kind: "bulk", ids: [...ctx.selectedIds] });
        return;
      }
      if (ctx.selectedId === null) return;
      e.preventDefault();
      setConfirmKeyboardDelete({ kind: "single", id: ctx.selectedId });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [ctx.selectedId, ctx.selectedIds, ctx.renamingId, confirmKeyboardDelete]);

  // Resolve the staged keyboard-delete confirmation. Cancel just clears the
  // gate; confirm dispatches to the existing trash handlers (which own undo
  // toasts, selection follow-through, and rollback on IPC failure).
  const cancelKeyboardDelete = useCallback(() => {
    setConfirmKeyboardDelete(null);
  }, []);
  const runKeyboardDelete = useCallback(() => {
    const target = confirmKeyboardDelete;
    setConfirmKeyboardDelete(null);
    if (target === null) return;
    if (target.kind === "bulk") {
      void handleBulkDelete();
    } else {
      void handleTrash(target.id);
    }
  }, [confirmKeyboardDelete, handleBulkDelete, handleTrash]);

  return (
    <div
      style={LIST_OUTER_STYLE}
      onContextMenu={handleBackgroundContextMenu}
      onClick={handleBackgroundClick}
    >
      {favRows.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            boxShadow: fm.favoritesDropActive
              ? "inset 0 0 0 2px var(--accent-soft)"
              : undefined,
          }}
          onDragOver={(e) => {
            // Drop in the section's non-row area = add to favorites. A favorite
            // row that handled the drag already called preventDefault (reorder),
            // so skip when over a row.
            if (e.defaultPrevented) return;
            if (fm.dragKind !== "note") return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            fm.setFavoritesDropActive(true);
          }}
          onDragLeave={() => fm.setFavoritesDropActive(false)}
          onDrop={(e) => {
            if (e.defaultPrevented) return; // a favorite row reorder handled it
            if (fm.dragKind !== "note") return;
            e.preventDefault();
            void fm.onFavoritesDropNote();
          }}
        >
          <div style={FAV_HEADER_STYLE}>
            <div style={SECTION_HEADING_STYLE}>
              {t("notes.list.favoritesHeading")}
            </div>
          </div>
          {/* Favorites is its OWN tree, and it has to be one (myne#728).
              Its rows are the same `NoteRow`, which is a `role="treeitem"`
              since this pass, and a treeitem with no `tree` ancestor is the
              exact `aria-required-parent` violation the pass exists to close.
              The block is a SIBLING of the main tree below, not part of it,
              so it cannot borrow that one's role. Flat by construction: a
              favourite is a note, never a folder. */}
          <div
            ref={favTreeRef}
            data-testid="notes.favorites-tree"
            role="tree"
            aria-label={t("notes.list.favoritesHeading")}
            tabIndex={0}
            onKeyDown={onFavTreeKeyDown}
          >
          {favRows.map((row) => {
            if (row.kind !== "note") return null;
            const record = ctx.cache.get(row.id);
            if (record === undefined) return null;
            const id = row.id;
            const favPlace =
              fm.favReorderTarget?.id === id ? fm.favReorderTarget.place : null;
            return (
              <div
                key={row.key}
                style={{ position: "relative" }}
                draggable={ctx.renamingId === null}
                onDragStart={(e) => fm.onNoteDragStart(e, id)}
                onDragEnd={fm.onDragEndCleanup}
                onDragOver={(e) => {
                  // Drop on a favorite row edge = place (add-or-reorder) at that
                  // slot. preventDefault stops the section's add-at-end handler.
                  if (fm.dragKind !== "note") return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  fm.updateFavReorderTarget(id, dragEdge(e));
                }}
                onDragLeave={() => fm.clearFavReorderTarget(id)}
                onDrop={(e) => {
                  if (fm.dragKind !== "note") return;
                  e.preventDefault();
                  void fm.reorderFavorite(id, dragEdge(e));
                }}
                // The non-drag path for that reorder (myne#728, WCAG 2.5.7,
                // found in review). Alt+Arrow is the rail's existing contract
                // (`RibbonCustomizeSettings`, `LeftRibbon`), not a new
                // gesture. Bound on the wrapper rather than inside `NoteRow`
                // so the tree's own plain arrows, which move the selection,
                // keep reaching the row untouched.
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  e.stopPropagation();
                  fm.moveFavorite(id, e.key === "ArrowUp" ? -1 : 1);
                }}
              >
                {favPlace && (
                  <div style={insertionLineStyle(favPlace)} aria-hidden="true" />
                )}
                {renderNoteRow(
                  record,
                  id,
                  true,
                  { level: row.level, posInSet: row.posInSet, setSize: row.setSize },
                  "favorites",
                )}
              </div>
            );
          })}
          </div>
          <div style={FAV_DIVIDER_STYLE} aria-hidden="true" />
        </div>
      )}
      <div style={HEADER_ROW_STYLE}>
        {/* The `NOTES` heading that used to sit here is gone (myne-md/myne#773).
            It labelled a region that can only ever contain notes, directly
            under the vault picker that already says where you are — a row of
            chrome carrying no information, on the surface with the least room
            to spare. The space now holds the app's only clickable route into
            the command palette. */}
        <div style={HEADER_LEAD_STYLE}>
          <SidebarSearchRow />
        </div>
        <div style={HEADER_ACTIONS_STYLE}>
          <NotesActionsBar
            onNewFolder={() => fm.startNewFolder("")}
            onCreate={onCreate}
            onNewDrawing={() => void ctx.createDrawingAndStartRename().catch(() => {})}
          />
        </div>
      </div>
      {fm.newFolder !== null && fm.newFolder.parentPath === "" && (
        // Root-level creation has no parent row to hang from, so the input takes
        // the tree's FIRST slot — where a top-level folder would appear — instead
        // of sitting above the tree as it did before (myne#952). Children are
        // rendered by their parent's row; see `renderFolderRow`.
        <NewFolderInput
          depth={0}
          parentPath=""
          onCommit={fm.commitNewFolder}
          onCancel={fm.cancelNewFolder}
        />
      )}
      <div
        // The sidebar's note hierarchy IS a tree (myne-md/myne#728): folder
        // rows have carried `role="treeitem"` and `aria-expanded` all along,
        // with no `tree` above them, which is the `aria-required-parent`
        // violation the axe baseline recorded. Note rows joined them as
        // treeitem leaves in the same change, because a treeitem without a
        // tree ancestor is a violation either way.
        //
        // `tabIndex` here is the OTHER half of the rows' roving tabindex: the
        // container is the Tab stop exactly when no ROW is.
        //
        // `treeOwnsTabStop` is computed rather than inferred from
        // `selectedId`, and the difference is three reachable states in which
        // the whole sidebar dropped out of the Tab order while this said
        // otherwise: the Attachments view (where `noteHighlightActive` is
        // false, so no row is selected even though `selectedId` is not null),
        // a selected row virtualized out of the window, and a selection that
        // lives only in the Favorites copy. Caught in review; the comment here
        // used to claim the virtualized case was handled and the predicate
        // never looked.
        ref={treeRef}
        // Named for the E2E lane (myne#728, review): there are now TWO
        // `role="tree"` elements in the sidebar and Favorites is the earlier
        // one in document order, so `querySelector('[role="tree"]')` silently
        // changes subject the moment a note is favourited. AK-2 was passing
        // only because its fixture favourites nothing, which its stated
        // preconditions did not say.
        data-testid="notes.tree"
        role="tree"
        aria-label={t("notes.list.treeLabel")}
        tabIndex={treeOwnsTabStop ? -1 : 0}
        onKeyDown={onTreeKeyDown}
        style={{
          flex: 1,
          minHeight: 0,
          boxShadow: fm.rootDropActive
            ? "inset 0 0 0 2px var(--accent-soft)"
            : undefined,
        }}
        onDragOver={(e) => {
          // Empty root AREA drop = unfile (folder:null). A row that handled the
          // drag already called preventDefault, so skip when over a row.
          if (e.defaultPrevented) return;
          if (fm.dragKind !== "note") return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          fm.setRootDropActive(true);
        }}
        onDragLeave={() => fm.setRootDropActive(false)}
        onDrop={(e) => {
          if (e.defaultPrevented) return; // a row handled the drop
          if (fm.dragKind !== "note") return;
          e.preventDefault();
          void fm.onRootDrop();
        }}
      >
        <VirtualList
          items={rows}
          keyOf={(row) => row.key}
          estimatedRowHeight={showTimestamps ? 44 : 30}
          heightResetToken={showTimestamps}
          overlayScrollbar
          renderItem={(row) => {
            const anim = treeAnimRows.get(row.key);
            if (row.kind === "folder") {
              return (
                <DisclosureWrapper
                  anim={anim?.mode ?? null}
                  delay={anim?.delay ?? 0}
                  railDepth={row.depth}
                >
                  <FolderRow
                    node={row.node}
                    depth={row.depth}
                    hierarchy={{
                      level: row.level,
                      posInSet: row.posInSet,
                      setSize: row.setSize,
                    }}
                    collapsed={row.collapsed}
                    empty={row.empty}
                    dropTarget={fm.dropTargetKey === row.node.key}
                    renaming={fm.renamingFolderKey === row.node.key}
                    dragKind={fm.dragKind}
                    reorderPlace={
                      fm.folderReorderTarget?.key === row.node.key
                        ? fm.folderReorderTarget.place
                        : null
                    }
                    onToggle={onToggleFolder}
                    onContextMenu={fm.openMenu}
                    colorSlot={fm.itemColors[row.node.key]}
                    iconName={fm.folderIcons[row.node.key]}
                    onDragTarget={fm.setDropTargetKey}
                    onDropNote={(folderPath) =>
                      void fm.onFolderDropNote(folderPath)
                    }
                    onDropFiles={(folderPath, files) =>
                      void handleDropFiles(folderPath, files)
                    }
                    onDragStartFolder={fm.onFolderDragStart}
                    onFolderReorderOver={(node, place) =>
                      fm.updateFolderReorderTarget(node.key, place)
                    }
                    onFolderReorderLeave={fm.clearFolderReorderTarget}
                    onFolderReorderDrop={(node, place) =>
                      void fm.onFolderReorder(node, place)
                    }
                    onDropFolderInto={(node) => {
                      // myne#281 — the dragged folder re-nests under the hovered
                      // one. `fm.dragFolder` is the node the drag started from;
                      // the guards (self/descendant, name collision, PATH_MAX)
                      // live in `moveFolderTo` so the menu entry gets them too.
                      const dragged = fm.dragFolderNode;
                      if (dragged === null) return;
                      void fm.moveFolderTo(dragged, node.path);
                    }}
                    onDragEnd={fm.onDragEndCleanup}
                    onCommitRename={(node, newName) =>
                      void fm.commitRenameFolder(node, newName)
                    }
                    onCancelRename={fm.cancelRenameFolder}
                    onOpenIndexNote={handleOpenIndexNote}
                    onCreateFolderNote={
                      // Withheld when the feature is off (myne-md/myne#661): the
                      // hover "create folder note" button is guarded on this
                      // callback's presence, so passing undefined hides it.
                      folderNotesEnabled
                        ? (folderPath) => void handleCreateFolderNote(folderPath)
                        : undefined
                    }
                    onActivate={handleFolderActivate}
                  />
                  {/* A new SUBFOLDER's input renders as this folder's child row
                      (myne#952). It used to render once, above the whole tree, no
                      matter which folder it was for — so the one thing the input
                      could not tell you was where the folder would land. Height is
                      measured by `VirtualList`'s ResizeObserver like any other row
                      growth. */}
                  {fm.newFolder !== null &&
                    fm.newFolder.parentPath !== "" &&
                    fm.newFolder.parentPath === row.node.path && (
                      <NewFolderInput
                        depth={row.depth + 1}
                        parentPath={fm.newFolder.parentPath}
                        onCommit={fm.commitNewFolder}
                        onCancel={fm.cancelNewFolder}
                      />
                    )}
                </DisclosureWrapper>
              );
            }
            const record = ctx.cache.get(row.id);
            if (record === undefined) return null;
            const id = row.id;
            const reorderPlace =
              fm.reorderTarget?.id === id ? fm.reorderTarget.place : null;
            return (
              <DisclosureWrapper
                anim={anim?.mode ?? null}
                delay={anim?.delay ?? 0}
                railDepth={row.depth}
              >
                <div
                  style={{
                    position: "relative",
                    // Same base offset folder rows use, so a note and a folder at
                    // the same depth start in the same column. Notes were missing
                    // it, which sat every note 8px left of its sibling folders and
                    // read as the tree losing its spine (MYND-622).
                    paddingInlineStart:
                      TREE_BASE_PADDING_LEFT + row.depth * NOTE_INDENT_PER_LEVEL,
                  }}
                  draggable={ctx.renamingId === null}
                  data-note-depth={row.depth}
                  onDragStart={(e) => fm.onNoteDragStart(e, id)}
                  onDragEnd={fm.onDragEndCleanup}
                  onDragOver={(e) => {
                    // Accept both kinds: a note reorders here; a folder reorders
                    // past this loose note (same-container). MYND-183 Task 6b.
                    if (fm.dragKind === null) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    fm.updateReorderTarget(id, dragEdge(e));
                  }}
                  onDragLeave={() => fm.clearReorderTarget(id)}
                  onDrop={(e) => {
                    if (fm.dragKind === null) return;
                    e.preventDefault();
                    void fm.onNoteReorder(id, dragEdge(e));
                  }}
                >
                  {reorderPlace && (
                    <div
                      style={insertionLineStyle(reorderPlace)}
                      aria-hidden="true"
                    />
                  )}
                  {renderNoteRow(record, id, favSet.has(id), {
                    level: row.level,
                    posInSet: row.posInSet,
                    setSize: row.setSize,
                  })}
                </div>
              </DisclosureWrapper>
            );
          }}
        />
      </div>
      {/* Selection announcement (myne#728, story 11). Visually hidden rather
          than `display: none`, which removes an element from the accessibility
          tree and would make this announce nothing. The single-space fallback
          is not decoration either: an empty region that later gains text is a
          change some screen readers do not report, so the region is always
          non-empty and it is the TEXT that changes. */}
      <div
        role="status"
        aria-live="polite"
        data-testid="notes.selection-announcement"
        style={VISUALLY_HIDDEN_STYLE}
      >
        {selectedTitle === null
          ? " "
          : t("notes.list.selectionAnnouncement", {
              title: selectedTitle.trim() === "" ? t("notes.list.untitled") : selectedTitle,
            })}
      </div>
      {fm.blockNotice !== null && (
        <div
          style={BLOCK_NOTICE_STYLE}
          role="status"
          onClick={fm.dismissBlock}
        >
          {fm.blockNotice}
        </div>
      )}
      {fm.caseMerge !== null && (
        <div ref={caseMergeDialogRef} style={CASE_MERGE_STYLE} role="alertdialog">
          <div>
            {t("notes.list.caseMergeBody", {
              name: fm.caseMerge.existingDisplay,
            })}
          </div>
          <div style={CASE_MERGE_ACTIONS_STYLE}>
            <button
              type="button"
              style={HEADER_BUTTON_STYLE}
              onClick={fm.cancelCaseMerge}
            >
              {t("notes.list.rename")}
            </button>
            <button
              type="button"
              style={{ ...HEADER_BUTTON_STYLE, color: "var(--fg-1)" }}
              onClick={fm.confirmCaseMerge}
            >
              {t("notes.list.mergeAnyway")}
            </button>
          </div>
        </div>
      )}
      {fm.confirmFolderDelete !== null && (
        <DeleteConfirmModal
          title={t("notes.list.deleteFolderTitle")}
          body={t("notes.list.deleteFolderBody", {
            name: fm.confirmFolderDelete.node.name,
            count: fm.confirmFolderDelete.noteCount,
          })}
          warning={t("notes.list.deleteFolderWarning")}
          confirmLabel={t("notes.list.deleteFolderConfirm")}
          onCancel={fm.cancelFolderDelete}
          onConfirm={fm.confirmFolderDeleteAction}
        />
      )}
      {confirmKeyboardDelete !== null && (
        <DeleteConfirmModal
          title={t("notes.list.trashConfirmTitle")}
          noteTitle={
            confirmKeyboardDelete.kind === "single"
              ? (ctx.cache.get(confirmKeyboardDelete.id)?.title ?? null)
              : undefined
          }
          body={
            confirmKeyboardDelete.kind === "bulk"
              ? t("notes.list.trashConfirmBulkBody", {
                  count: confirmKeyboardDelete.ids.length,
                })
              : undefined
          }
          warning={
            confirmKeyboardDelete.kind === "bulk"
              ? t("notes.list.trashConfirmBulkWarning")
              : t("notes.list.trashConfirmWarning")
          }
          confirmLabel={t("notes.list.trashConfirmConfirm")}
          onCancel={cancelKeyboardDelete}
          onConfirm={runKeyboardDelete}
        />
      )}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={closeMenu}
        />
      )}
      {moveTarget !== null && (
        <ContextMenu
          x={moveTarget.x}
          y={moveTarget.y}
          items={moveMenuItems}
          searchable
          tree
          searchPlaceholder={t("commands.picker.moveNotePlaceholder")}
          onClose={() => setMoveTarget(null)}
        />
      )}
      {folderMoveTarget !== null && (
        <ContextMenu
          x={folderMoveTarget.x}
          y={folderMoveTarget.y}
          items={folderMoveMenuItems}
          searchable
          tree
          searchPlaceholder={t("commands.picker.moveNotePlaceholder")}
          onClose={() => setFolderMoveTarget(null)}
        />
      )}
      {fm.menu !== null && (
        <ContextMenu
          x={fm.menu.x}
          y={fm.menu.y}
          items={folderMenuItems}
          onClose={fm.closeMenu}
        />
      )}
      {bgMenu !== null && (
        <ContextMenu
          x={bgMenu.x}
          y={bgMenu.y}
          items={bgMenuItems}
          onClose={closeBgMenu}
        />
      )}
      {decoPopover !== null && (
        <DecorationPopover
          x={decoPopover.x}
          y={decoPopover.y}
          color={fm.itemColors[decoPopover.key] ?? null}
          onSelectColor={(slot) => fm.setItemColor(decoPopover.key, slot)}
          icon={
            decoPopover.folderPath !== null
              ? {
                  value: fm.folderIcons[decoPopover.folderPath] ?? null,
                  onSelect: (name) =>
                    fm.setFolderIcon(decoPopover.folderPath as string, name),
                }
              : undefined
          }
          onClose={closeDecoPopover}
        />
      )}
      <Toast
        message={undoToast === null ? null : t("notes.list.noteMovedToTrash")}
        onDone={() => setUndoToast(null)}
        durationMs={6000}
        action={{ label: t("notes.list.undo"), onAction: handleUndoTrash }}
      />
      <Toast
        message={
          bulkUndo === null
            ? null
            : t("notes.list.notesMovedToTrash", { count: bulkUndo.length })
        }
        onDone={() => setBulkUndo(null)}
        durationMs={6000}
        action={{ label: t("notes.list.undo"), onAction: handleUndoBulk }}
      />
      <Toast
        message={importToast}
        onDone={() => setImportToast(null)}
        durationMs={5000}
      />
      <Toast message={trashError} onDone={() => setTrashError(null)} variant="error" />
    </div>
  );
}

/** Inline name input for creating a new folder (auto-focuses; Enter commits,
 *  Esc cancels, blur commits a non-empty name).
 *
 *  `depth` puts it in the TREE at the level the folder will actually be created
 *  at (myne#952): same base offset and per-level step a folder row uses, plus the
 *  indent rails of every ancestor level. Rendered by its parent's row (or by the
 *  tree's head slot for the vault root), so the input sits where the folder is
 *  about to appear instead of above the whole tree. */
function NewFolderInput({
  parentPath,
  depth,
  onCommit,
  onCancel,
}: {
  parentPath: string;
  depth: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    // The parent may be far down a long sidebar: starting a subfolder has to
    // bring its input into view, or the caret lands somewhere invisible and the
    // keystrokes go nowhere the user can see.
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const commit = () => {
    const v = ref.current?.value.trim() ?? "";
    if (v.length > 0) onCommit(v);
    else onCancel();
  };
  return (
    <div
      style={{
        ...NEW_FOLDER_ROW_STYLE,
        position: "relative",
        paddingInlineStart:
          TREE_BASE_PADDING_LEFT + depth * NOTE_INDENT_PER_LEVEL,
      }}
    >
      <TreeRails depth={depth} />
      <input
        ref={ref}
        type="text"
        data-testid="notes.new-folder-input"
        placeholder={
          parentPath === ""
            ? t("notes.list.newFolderPlaceholder")
            : t("notes.list.newFolderInPlaceholder", { path: parentPath })
        }
        style={NEW_FOLDER_INPUT_STYLE}
        onContextMenu={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}
