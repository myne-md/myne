// The agent Hub: the vault-general conversation list (myne-md/myne#771 task 3).
//
// ── What this is ────────────────────────────────────────────────────────────
// The Hub is the agent tab's default view and the half that "sees all of the sub
// past ones": every conversation in the vault, note-anchored ones included, newest
// first. It is a list you dwell in, which is why it is a tab view rather than a
// modal (`polish-epic-prompt.md` D3).
//
// ── Data ────────────────────────────────────────────────────────────────────
// `chatsList` returns the catalog roster; the row carries its id at the read
// boundary. Opening a row binds the transcript to it (`openConversation`);
// rename and delete are catalog mutations. The list re-fetches after every
// mutation rather than patching locally, so a sync arrival is never missed and
// the row order stays the backend's.
//
// ── The empty states are DISTINCT, which is the point of the slice ───────────
// A filtered-to-nothing list is not an empty vault, and a vault with no
// conversations is not a broken provider. The first-run state offers a first
// action; the no-provider state says what to fix. Search/filter arrives in task 5
// and adds the third variant.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { useDateTimeDisplay } from "../../lib/useDateTimeDisplay";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { IconButton } from "../../components/primitives/IconButton";
import { Input } from "../../components/primitives/Input";
import { Tooltip } from "../../components/primitives/Tooltip";
import { EmptyState } from "../../components/primitives/EmptyState";
import {
  chatsDelete,
  chatsList,
  chatsRead,
  chatsRename,
  subscribeConversationRoster,
  type ConversationListRow,
} from "../../lib/chats";
import {
  clearChatPersistForLock,
  openConversation,
  parseTranscript,
} from "../ai/chatPersist";
import { discardChat, getActiveConversationId } from "../ai/chatStore";
import { useAgent } from "./agentStore";
import { useSelectedNote } from "../sidebarState";
import { generateNoteTitle } from "../ai/noteTitle";
import { isNoteAiExcluded } from "../../lib/aiExcludedFolders";
import { flushBeforeFrontmatterWrite } from "../flushBeforeFrontmatterWrite";
import { noteRead } from "../readNote";
import { usePrefs } from "../../hooks/usePrefs";
import { loadModelPath } from "../../lib/ai-model-store";
import { formatDuration, useElapsedMillis } from "./components/AgentFootprint";
import { endStatusLabel } from "./components/AgentProgress";
import { VISUALLY_HIDDEN } from "../../components/primitives/visuallyHidden";
import { Spinner } from "../../components/Spinner";
import { AnchoredPanel } from "../../components/primitives/AnchoredPanel";
import { ScrollArea } from "../../components/primitives/ScrollArea";
import { byUpdatedDesc, relativeDay } from "../ai/conversationList";

/**
 * A rail row: the title on one line, its meta and actions on the next.
 *
 * It was ONE line holding a title, an anchor pill, a date and two text buttons
 * ("Rename", "Delete"). At the rail's 248px that is far more than fits, and
 * because the list set `overflow-y: auto`, which per spec computes
 * `overflow-x` to `auto` as well — the whole list scrolled SIDEWAYS. The user
 * saw rows shifted half out of view with a horizontal scrollbar under them.
 *
 * Two lines is what a 248px column can hold. The list's scroller pins
 * `overflow-x: hidden` now, so a future row that outgrows it truncates rather
 * than reintroducing the scroll.
 */
/** What a conversation is about, as the card states it: the three kinds a
 *  catalog row can carry, in the order the row can be trusted. */
type HubTarget = "folder" | "note" | "vault";

/** The glyph per kind, so the card answers "which shape" in one place. */
const TARGET_ICON: Record<HubTarget, "folder" | "file-text" | "book-open"> = {
  folder: "folder",
  note: "file-text",
  vault: "book-open",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: "var(--space-1)",
  padding: "var(--space-2)",
  borderRadius: "var(--radius-2)",
  // **No border, deliberately** (myne-md/myne#848). This style is shared, so a
  // hairline here is a box around every conversation, which read as "every card
  // is highlighted" and left the open one indistinguishable. Rows are separated
  // by a rule between them, and the open one carries an inset accent ring.
  textAlign: "left",
  minWidth: 0,
};

/** The title line: the label, and the actions that act on it. */
const ROW_TOP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  minWidth: 0,
};

/** The title action's line: what it is doing, or why it could not. Same row as
 *  the date, and the same reason it carries no top margin. */
const TITLE_NOTICE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

/** The card's state line: the run's own status, beside the date.
 *
 *  **No `marginTop`** (myne-md/myne#848, on the user's read: "these two texts
 *  are not aligned"). It is a flex item of `ROW_META_STYLE`, which is a ROW with
 *  `align-items: center`, so a top margin does not push it onto its own line,
 *  it pushes it four pixels DOWN inside the row it shares with the date, which
 *  is exactly the misalignment. The stacking intent was in the comment rather
 *  than in the layout. */
const RUN_STATE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  minWidth: 0,
};

/** The unread mark: the accent, at rest, at the end of the title line. */
const UNREAD_DOT_STYLE: CSSProperties = {
  flex: "none",
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "var(--accent)",
  // A ring in the rail's own surface, so the dot reads as sitting ON the card
  // rather than as a bullet of the title.
  boxShadow: "0 0 0 2px var(--bg-1)",
};

/** The hover menu: a small panel anchored to the row's action cluster. */
const MENU_STYLE: CSSProperties = {
  // Chrome only. **Placement belongs to `AnchoredPanel`** (myne-md/myne#848):
  // it decides `position: fixed`, the stacking level, the side with room and the
  // offset, and re-declaring any of them here would be a second answer to a
  // question the primitive already owns.
  display: "flex",
  flexDirection: "column",
  minWidth: 120,
  padding: "var(--space-1)",
  gap: "var(--space-1)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
};

/** Only what the primitive does not already do: a menu item is left-aligned and
 *  full width, where a `Button` centres its label and hugs it. */
const MENU_ITEM_STYLE: CSSProperties = {
  textAlign: "left",
  justifyContent: "flex-start",
  width: "100%",
  padding: "var(--space-1) var(--space-2)",
};

/**
 * The opening words, short enough to be a TOOLTIP.
 *
 * **A tooltip is not a paragraph** (myne-md/myne#848): the bubble is one line
 * (`white-space: nowrap`), so a full first message rendered as a 900px ribbon
 * across the window. Sixty scalar values is about a line of the rail's width and
 * enough to tell two similar conversations apart, which is the whole job.
 */
function previewOf(text: string): string {
  const points = [...text.trim()];
  return points.length <= 60 ? points.join("") : points.slice(0, 60).join("") + "\u2026";
}

/** The meta line: what it is about, and when it was last used. */
const ROW_META_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  minWidth: 0,
};

/** The anchor pill: it may shrink, so the date beside it never moves. The
 *  `.myne-pill` class ships `flex-shrink: 0` (right for a fixed label, wrong for
 *  a note name of any length), so the shrink is restored here and the inner
 *  span does the ellipsizing, `text-overflow` on the pill itself would be inert
 *  over an anonymous flex item. */
const ANCHOR_PILL_STYLE: CSSProperties = {
  flex: "0 1 auto",
  minWidth: 0,
};

const ANCHOR_TITLE_STYLE: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** The title's slot: sized to the text, able to shrink, and deliberately NOT
 *  the row's flexible cell (myne-md/myne#848, see the call site). */
const TITLE_SLOT_STYLE: CSSProperties = {
  display: "flex",
  flex: "0 1 auto",
  minWidth: 0,
};

const TITLE_STYLE: CSSProperties = {
  maxWidth: "100%",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "none",
  border: "none",
  padding: 0,
  textAlign: "left",
  cursor: "pointer",
};

/**
 * The row's actions, pinned to the far edge.
 *
 * A title with `flex: 1` was not enough: the title button is wrapped in a
 * `<Tooltip>`, so the FLEX ITEM is the tooltip's wrapper and the `flex: 1` sat
 * on a child of it, where the row's free space never reaches. The actions ended
 * up hugging the end of each title ("hi ✏🗑") so the two controls landed in a
 * different place on every row and a column of them read as ragged rather than
 * as a column.
 *
 * `margin-inline-start: auto` is the fix rather than fixing the title's flex,
 * because it holds however the title is wrapped: a tooltip, a badge, a second
 * label later. `flex: none` so the pair never shrinks into each other on a
 * narrow rail — the title is what ellipsizes.
 *
 * And since myne-md/myne#848 that is also what lets the title NOT grow: the
 * tooltip's trigger is the title's own box, so the title must be sized to its
 * text, and this auto margin is what keeps the right edge held while it is.
 */
const ROW_ACTIONS_STYLE: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  flex: "none",
  marginInlineStart: "auto",
};

const META_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  whiteSpace: "nowrap",
  // The date is the row's fixed half: the note name beside it is what gives way
  // when the rail is narrow.
  flex: "none",
};

const ERROR_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
  margin: 0,
};

/** The rail's two non-list controls, on one row. */
const RAIL_HEADER_STYLE: CSSProperties = {
  display: "flex",
  // `stretch`, not `center`: the input and the button compute their heights
  // from different padding tokens, so centring left them a few pixels apart.
  // Stretching gives both the row's height; the button keeps its glyph centred
  // because it is itself an inline-flex with `align-items: center`.
  alignItems: "stretch",
  gap: "var(--space-1)",
  minWidth: 0,
};

/** The list's outer box: it takes the rail's remaining height.
 *
 *  **The app's own `ScrollArea`, not a native `overflow-y: auto`**
 *  (myne-md/myne#867, on the user's read: "the scroll bar stays open all the
 *  time, and it is too thick"). The native bar follows the OS setting and on a
 *  machine set to always show scroll bars it never hides; the primitive's
 *  indicator appears on hover, focus and scroll only. It also pins
 *  `overflow-x: hidden` on its scroller, which this list relies on: a row wider
 *  than the rail must truncate, not scroll the whole history sideways. */
const LIST_STYLE: CSSProperties = {
  minHeight: 0,
  minWidth: 0,
  flex: 1,
};

/** The scroller's own layout: one column of rows.
 *
 *  **No `gap`** (myne-md/myne#867, on the user's read: "the space above and
 *  below the hover is different"). The separator is each row's BOTTOM border,
 *  so a gap put four pixels between a card and the rule above it and none
 *  between the card and the rule below it, which the hover background made
 *  visible. Rows carry their own symmetric block padding instead
 *  (`ROW_WRAP_STYLE`). */
const LIST_CONTENT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
};

export interface AgentHubListProps {
  /** Open an existing conversation in the main column, carrying the note it is
   *  anchored to. The pane owns the workspace write, so the rail does not reach
   *  into it. */
  onOpenFocus: (next: {
    conversationId?: string;
    noteId?: string | null;
  }) => void;
  /** Start a fresh conversation. Separate from `onOpenFocus` because they are
   *  different acts: one selects, the other creates, and collapsing them into
   *  "open with no id" is how a New-chat button ends up reopening the last one. */
  onNewConversation?: () => void;
  /** The conversation currently in the main column, so the rail can mark it.
   *  Read from the WORKSPACE rather than from the chat store: the store's
   *  active id is the live transcript, which lags a selection by a round trip
   *  and would leave the rail highlighting the previous row mid-switch. */
  activeConversationId?: string | null;
  /** Open the note a conversation is anchored to, in the workspace. */
  onOpenNote?: (noteId: string) => void;
}

export function AgentHubList({
  onOpenFocus,
  onNewConversation,
  activeConversationId = null,
  onOpenNote,
}: AgentHubListProps) {
  const { t } = useTranslation();
  const { locale, timeZone } = useDateTimeDisplay();
  // **Which conversation has a run in flight** (myne-md/myne#848). The run
  // belongs to its conversation rather than to the surface, so it can be
  // working while the user is somewhere else entirely, and a list that shows
  // neither the run nor where it is leaves "did my message go?" unanswerable
  // without opening every row. `running` is the whole guard: a settled or
  // cancelled run clears it in the same action that settles the step, so the
  // mark cannot outlive the run.
  const agent = useAgent();
  const unreadConversations = agent.unreadConversations;
  // The note titles, from the cache the sidebar already fills, the same source
  // `useRunViewContext` resolves a title from by id, and an in-memory read
  // rather than an IPC call per card. The RAW cache, not the live working set:
  // a conversation anchored to a note that has since been trashed is still
  // anchored to it, and its name is still the truth about which note that is.
  const { cache } = useSelectedNote();
  const noteTitle = useCallback(
    (id: string): string | null => {
      const title = cache.get(id)?.title ?? null;
      return title !== null && title.trim() !== "" ? title : null;
    },
    [cache],
  );
  const runningId = agent.running ? agent.runConversationId : null;
  /**
   * **The card you pressed is marked at once** (myne-md/myne#848).
   *
   * The active id comes from the surface, which learns it after a round trip
   * (read the conversation, bind the transcript), so a rail keyed only off it
   * marked the PREVIOUS row for as long as the open took. That lag was invisible
   * while the mark was a background a shade off the rail; with the accent border
   * it read as "every card I press highlights the wrong one". The pending id is
   * cleared the moment the surface reports one, so the two cannot disagree for
   * longer than the open itself.
   */
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null);
  /**
   * **The card menu hangs off the row's actions, and is drawn in the BODY.**
   *
   * It used to render inside the card, absolutely positioned under the trigger,
   * and the list's own `overflow: auto` clipped it: a menu on the last visible
   * card lost its lower half, and one near the rail's edge lost a side. Nothing
   * reported it, because the panel and its items were in the DOM and every test
   * that finds one by testid passed. `AnchoredPanel` owns the portal, the
   * placement and the three ways out.
   */
  const menuTriggerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeConversationId !== null) setPendingOpenId(null);
  }, [activeConversationId]);
  /** When the running run started, for the card's duration. Read from the store
   *  rather than tracked here: the run outlives this component, so a rail that
   *  mounted mid-run has to show the time already spent. */
  const runningSince = agent.running ? agent.startedAtMillis : null;
  // **The hook's VALUE is the figure, and it used to be thrown away**
  // (myne-md/myne#848): the call was made for its re-render alone and the same
  // number recomputed below with `Date.now()`, which is the hook's own body. The
  // rail and the transcript now cannot count a run differently, which is what
  // the comment claimed while the arithmetic was written twice.
  const elapsedMillis = useElapsedMillis(runningSince, true);
  const [rows, setRows] = useState<ConversationListRow[] | null>(null);
  const [error, setError] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Which row the pointer or the keyboard is on, which row's menu is open, and
  // the opening-words preview for the hovered one. Local rather than store state:
  // all three describe the POINTER, not the catalog.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; text: string | null } | null>(null);
  /** Conversation id → opening words, `null` for one that has none. A Map so a
   *  row hovered twice reads once; component-scoped rather than module-scoped so
   *  a lock that unmounts the hub takes the plaintext with it. */
  const hoverCache = useRef(new Map<string, string | null>());
  /**
   * What just happened, announced (task 13 of myne-md/myne#771).
   *
   * Rename, delete and a failed reload all change the list WITHOUT moving
   * focus, so a screen-reader user pressed a button and heard nothing: the row
   * they were on either changed name underneath them or stopped existing. A
   * live region is the only channel that reports a change the user did not
   * navigate to.
   *
   * Cleared on the next interaction rather than on a timer: a message that
   * erases itself races the reader that is announcing it.
   */
  const [announcement, setAnnouncement] = useState("");
  // The workspace's selection when the pane supplies one, the live transcript
  // otherwise (the light panel mounts this list with neither), and the card the
  // user just PRESSED first of all, until the surface reports one (myne-md/myne#848).
  const activeId = pendingOpenId ?? activeConversationId ?? getActiveConversationId();

  /**
   * **The note-title action** (myne-md/myne#848, on the user's ask).
   *
   * Three pieces of state, because the press has three possible endings and the
   * surface owes a different sentence to each: a local generation model that is
   * missing (disabled item), a model that answered with nothing usable, and a
   * write that failed. The SUCCESS needs no line, the anchor pill beside it
   * renames itself, because the sidebar cache updates on the write, and it gets
   * an announcement instead, for the reader who cannot see the pill change.
   */
  const [hasTitleModel, setHasTitleModel] = useState(false);
  const [titleBusyId, setTitleBusyId] = useState<string | null>(null);
  const [titleNotice, setTitleNotice] = useState<
    { id: string; key: string } | null
  >(null);
  // Read once per mount. `plugin:local-inference` does not exist on every client
  // (the web bundle has no local engine), so a missing command is "no model"
  // rather than an error to report.
  useEffect(() => {
    void loadModelPath("generation").then(
      (path) => setHasTitleModel(path !== null),
      () => setHasTitleModel(false),
    );
  }, []);
  // Renamed on destructure: the hub's own `commitRename` renames the
  // CONVERSATION, and this one renames a NOTE through the sidebar's
  // transactional path. Two different writes under one word is how the wrong one
  // gets called.
  const { commitRename: commitNoteRename } = useSelectedNote();
  const { prefs } = usePrefs();
  // **Whether an AI read of this note is allowed at all** (SYNC-14): the same
  // predicate every other AI entry point uses, against the same pref, read from
  // the cache the card already has in hand. It is checked before the model is
  // asked and again at the menu item, because the guarantee is that AI never
  // runs for an excluded note, and a gate that only hides the control is a gate
  // the next caller can forget.
  const titleReadAllowed = useCallback(
    (noteId: string): boolean =>
      !isNoteAiExcluded(
        cache.get(noteId)?.folder ?? "",
        prefs.ai_excluded_folders,
      ),
    [cache, prefs.ai_excluded_folders],
  );
  const generateTitle = useCallback(
    // **Two ids, and both are needed**: the NOTE is what gets renamed, and the
    // CONVERSATION is the card that reports what happened. Keying the busy and
    // notice state on the note id left both lines rendering for no card at all,
    // `row.id` is a conversation id.
    async (conversationId: string, noteId: string): Promise<void> => {
      setTitleNotice(null);
      setTitleBusyId(conversationId);
      const outcome = await generateNoteTitle(noteId, titleReadAllowed(noteId));
      setTitleBusyId(null);
      switch (outcome.kind) {
        case "ready":
          try {
            // **The note's own rename path, not a title write**
            // (myne-md/myne#848): `commitRename` is §8.3's transactional batch,
            // which also rewrites every inbound `[[Old Title]]` and flushes open
            // panes before reading them. Writing the frontmatter here would
            // leave every link to this note pointing at a title that no longer
            // exists.
            //
            // **The body is read HERE, not when the model was asked** (review
            // finding): the generation takes seconds, and a body read before it
            // overwrote whatever landed in between. Flush, then read, then
            // commit, which is the order `executeRenameCommit` uses.
            await flushBeforeFrontmatterWrite();
            const bytes = await noteRead(noteId);
            await commitNoteRename(noteId, bytes, outcome.title);
            setAnnouncement(
              t("agent.hub.titleGenerated", { name: outcome.title }),
            );
          } catch {
            setTitleNotice({
              id: conversationId,
              key: "agent.hub.titleSaveFailed",
            });
          }
          return;
        case "excluded":
          // Reachable only if the pref changed between the menu opening and the
          // press, since the item is not offered otherwise.
          setTitleNotice({
            id: conversationId,
            key: "agent.hub.generateTitleExcluded",
          });
          return;
        case "unavailable":
          setHasTitleModel(false);
          setTitleNotice({
            id: conversationId,
            key: "agent.hub.generateTitleNeedsModel",
          });
          return;
        case "no-title":
        case "failed":
          setTitleNotice({ id: conversationId, key: "agent.hub.titleFailed" });
          return;
      }
    },
    [commitNoteRename, t, titleReadAllowed],
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setRows(byUpdatedDesc(await chatsList()));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  // Load once, then follow the roster.
  //
  // **The subscription is the half that was missing.** This list loaded on
  // mount and nothing told it anything afterwards, so a conversation created by
  // SENDING a message did not appear in the rail beside the reply that created
  // it — the user watched an answer arrive into a history that claimed there
  // was nothing there. It came back on the next mount, which made it look like
  // a refresh problem rather than a missing wire.
  //
  // `subscribeConversationRoster` fires from the three chats wrappers
  // themselves, so a future write site cannot forget to announce: the
  // announcement is in the path, not beside it.
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void chatsList().then(
        (list) => {
          if (!cancelled) setRows(byUpdatedDesc(list));
        },
        () => {
          if (!cancelled) setError(true);
        },
      );
    };
    load();
    const unsubscribe = subscribeConversationRoster(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const handleOpen = useCallback(
    async (id: string): Promise<void> => {
      // Marked BEFORE the await, which is the whole point of the pending id: the
      // press is the user's intent and it is known now.
      setPendingOpenId(id);
      if (id !== getActiveConversationId()) {
        const outcome = await openConversation(id);
        if (outcome !== "opened") {
          setError(true);
          setPendingOpenId(null);
          return;
        }
      }
      // **With the note it is anchored to.** It opened by id alone, so the
      // anchor was dropped on the way in: a conversation whose every turn says
      // "Working on: This note" came back with no scope at all, and the
      // composer asked the user to choose a folder for a conversation that had
      // been about a note the whole time. The row already knows — `note_id` is
      // on the catalog row and is why the anchor chip renders beside it.
      const row = (rows ?? []).find((r) => r.id === id);
      onOpenFocus({ conversationId: id, noteId: row?.note_id ?? null });
    },
    [onOpenFocus, rows],
  );

  /** Read ONE conversation's opening words, for the hovered row only.
   *
   *  Lazy and cached on purpose: the roster carries no preview field, and
   *  reading every conversation to render a list of titles would decrypt the
   *  whole vault on every mount. The id is carried with the text so a reply that
   *  lands after the pointer moved cannot put one conversation's words on
   *  another's card. */
  const loadHoverText = useCallback(async (id: string): Promise<void> => {
    const cached = hoverCache.current.get(id);
    if (cached !== undefined) {
      setHover({ id, text: cached });
      return;
    }
    try {
      const turns = parseTranscript(await chatsRead(id));
      const first = turns?.find((t) => t.role === "user" && t.text.trim().length > 0);
      const text = first === undefined ? null : first.text;
      hoverCache.current.set(id, text);
      setHover({ id, text });
    } catch {
      hoverCache.current.set(id, null);
      setHover({ id, text: null });
    }
  }, []);

  const commitRename = useCallback(
    async (id: string): Promise<void> => {
      const title = draft.trim();
      if (title.length === 0) {
        setRenamingId(null);
        return;
      }
      try {
        await chatsRename(id, title);
        setRenamingId(null);
        setAnnouncement(
          t("agent.hub.renamedAnnouncement", { name: draft.trim() }),
        );
        await refresh();
      } catch {
        setError(true);
      }
    },
    [draft, refresh, t],
  );

  const commitDelete = useCallback(
    async (id: string): Promise<void> => {
      try {
        await chatsDelete(id);
        // Only the open transcript dies with its conversation, and it dies
        // WITHOUT a persist: the turns are deleted by intent.
        if (getActiveConversationId() === id) {
          discardChat();
          clearChatPersistForLock();
        }
        setDeletingId(null);
        setAnnouncement(t("agent.hub.deletedAnnouncement"));
        await refresh();
      } catch {
        setError(true);
      }
    },
    [refresh, t],
  );

  if (error) {
    return (
      <p data-testid="agent.hub-error" style={ERROR_STYLE}>
        {t("agent.hub.loadFailed")}
      </p>
    );
  }
  if (rows === null) {
    return (
      <p data-testid="agent.hub-loading" style={META_STYLE}>
        {t("agent.hub.loading")}
      </p>
    );
  }
  // Filter by title, case-insensitively. Server-side search is not this slice:
  // the catalog is small and already in memory. Computed AFTER the null and
  // empty returns, so `rows` is narrowed to a real array.
  const q = query.trim().toLowerCase();
  const visible =
    q.length === 0
      ? rows
      : rows.filter((r) => r.title.toLowerCase().includes(q));

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* The announcement channel. `polite` rather than `assertive`: these are
          confirmations of something the user just did, not interruptions.
          Always MOUNTED, never conditionally rendered — a live region that
          appears at the same moment its text does is a region most readers
          never announce, because they were not watching an element that did
          not exist. */}
      <span
        role="status"
        aria-live="polite"
        data-testid="agent.hub-announcer"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {announcement}
      </span>
      {/* Start a new one, above the list. Without this the Hub is a surface you
          can only ever CONTINUE from: the empty state's action disappears the
          moment there is one conversation, and a user with a single old chat
          would have no way to begin a second from here.

          Conditional on a note being open for the same reason the empty
          state's action is: a run needs a scope the host will accept, and with
          no note open there is none. */}
      {/* **The search and New chat share a row.** They were stacked, which in a
          248px rail spent two full rows on the two controls that are not the
          list — and the list is what the rail is for.

          New chat is icon-only and ACCENT: it is the one thing on this surface
          that creates something, and everything else here opens, renames or
          deletes what already exists. It was gated on a note being open, which
          was right while starting a conversation meant opening a view that
          needed a scope; a conversation is its own subject now, and what still
          needs a note is SENDING, which the composer refuses on its own.

          `<Button variant="primary" icon>` rather than `<IconButton>`: the
          primitive has no accent arm, and it is the fill that carries "this is
          the one that makes something". Its label is the tooltip AND the
          accessible name, per the epic's convention — an icon-only control
          with no name is a guess. */}
      <div style={RAIL_HEADER_STYLE}>
        <Input
          type="search"
          data-testid="agent.hub-search"
          aria-label={t("agent.hub.searchLabel")}
          placeholder={t("agent.hub.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // `--radius-2`, the button's, rather than the input default
          // `--radius-1`: in this row the two controls sit flush beside each
          // other at the same height, and two corner radii a few pixels apart
          // read as a mismatch rather than as two kinds of control.
          style={{ flex: 1, minWidth: 0, borderRadius: "var(--radius-2)" }}
        />
        {onNewConversation !== undefined && (
          <Tooltip label={t("agent.hub.newConversation")}>
            <Button
              variant="primary"
              icon="plus"
              aria-label={t("agent.hub.newConversation")}
              data-testid="agent.hub-new"
              onClick={onNewConversation}
              style={{ flex: "none" }}
            />
          </Tooltip>
        )}
      </div>

      {rows.length === 0 ? (
        // First run: nothing to list yet. A QUIET line under the header, not a
        // card with its own button (design-notes/ui/0643). The header above
        // already carries the one action that creates a conversation, and the
        // conversation beside this rail carries the zero state that explains
        // what the agent is — a second bordered card with a second "New
        // conversation" button, side by side with the first, is what made the
        // empty agent tab look assembled rather than designed.
        //
        // No wash: the conversation's zero state carries it, and two washes a
        // hairline apart compete instead of framing anything.
        <EmptyState
          variant="firstRun"
          icon="message-square"
          size="sm"
          fill
          field={false}
          title={t("agent.hub.emptyTitle")}
          body={t("agent.hub.emptyBody")}
          testId="agent.hub-empty"
        />
      ) : visible.length === 0 ? (
        // A filtered-to-nothing list is NOT an empty vault: it echoes the query
        // and offers the way back. `<PanelEmptyState>` cannot say that — it is
        // hardwired to `firstRun`, which is the whole distinction this variant
        // exists to draw, and the comment here claimed the filtered variant
        // while rendering the other one. Straight to `<EmptyState>`, with the
        // query echoed through the prop that bidi-isolates it.
        <EmptyState
          variant="filtered"
          icon="search"
          size="sm"
          title={t("common.nomatches")}
          body={t("agent.hub.noMatchBody", { query: "" }).trim()}
          query={query.trim()}
          testId="agent.hub-no-match"
          action={
            <Button variant="secondary" icon="x" onClick={() => setQuery("")}>
              {t("common.clearsearch")}
            </Button>
          }
        />
      ) : (
        <ScrollArea
          testId="agent.hub-list"
          style={LIST_STYLE}
          contentStyle={LIST_CONTENT_STYLE}
        >
          {visible.map((row, index) => {
            // **The unread mark** (myne-md/myne#848): a run settled for this
            // conversation and nothing has displayed it since. Read from the run
            // store, which is where the settle writes it and where the surface
            // that shows the conversation clears it.
            const isUnread = unreadConversations.includes(row.id);
            // `null` when the note is not in the cache (a deleted note, or a
            // vault whose sidebar has not filled yet): the pill then falls back
            // to saying the KIND of anchor rather than inventing a name.
            const anchorTitle =
              row.note_id === undefined ? null : noteTitle(row.note_id);
            // What the conversation is ABOUT: a folder scope, a note anchor, or
            // neither, the whole vault. The two optional fields are additive
            // and a row carries at most one of them.
            // Whether the generation may read this note at all (SYNC-14).
            const titleAllowed =
              row.note_id === undefined || titleReadAllowed(row.note_id);
            const titleReason = !titleAllowed
              ? t("agent.hub.generateTitleExcluded")
              : hasTitleModel
                ? null
                : t("agent.hub.generateTitleNeedsModel");
            const target: HubTarget =
              row.folder !== undefined
                ? "folder"
                : row.note_id !== undefined
                  ? "note"
                  : "vault";
            // Only the run the store still HOLDS can say what it produced; an
            // older unread conversation keeps the dot alone, because the count
            // would be a claim about a run this store no longer has.
            //
            // **A setting change counts** (myne-md/myne#850, from the 2026-10-14
            // review): a settings-only run used to compute 0 here, so the card
            // said nothing had happened.
            const changes =
              row.id === agent.runConversationId && agent.end !== null
                ? agent.proposal.edits.length +
                  agent.proposal.newNotes.length +
                  (agent.proposal.settings?.length ?? 0)
                : 0;
            return (
            <div
              key={row.id}
              data-testid="agent.hub-row"
              data-conversation-id={row.id}
              data-running={row.id === runningId ? "true" : "false"}
              // **A separator BETWEEN conversations, not a box around each**
              // (myne-md/myne#848). A hairline under every row but the last is
              // what makes a list read as a list; a border on all four sides of
              // every row reads as a grid of highlighted boxes.
              style={{
                // The same space on both sides of the card, so a hovered or
                // open card sits centred between its two rules.
                paddingBlock: "var(--space-1)",
                borderBottom:
                  index < visible.length - 1 ? "1px solid var(--line-1)" : undefined,
              }}
            >
              {deletingId === row.id ? (
                <div
                  style={{
                    ...ROW_STYLE,
                    flexDirection: "column",
                    alignItems: "stretch",
                    // The one place the hairline stays: this panel is a
                    // confirmation inside the row, and without an edge it reads
                    // as the row's own content (myne-md/myne#848).
                    border: "1px solid var(--line-1)",
                  }}
                >
                  <p
                    style={{
                      ...ERROR_STYLE,
                      color: "var(--fg-1)",
                      margin: 0,
                      fontWeight: "var(--weight-medium)",
                    }}
                  >
                    {t("editor.chrome.rightPanel.aiChat.historyDeleteTitle")}
                  </p>
                  <p
                    style={{ ...ERROR_STYLE, color: "var(--fg-1)", margin: 0 }}
                  >
                    {t("editor.chrome.rightPanel.aiChat.historyDeleteBody")}
                  </p>
                  <div
                    style={{
                      display: "flex",
                      gap: "var(--space-2)",
                      justifyContent: "flex-end",
                    }}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      data-testid="agent.hub-delete-cancel"
                      onClick={() => setDeletingId(null)}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      data-testid="agent.hub-delete-confirm"
                      onClick={() => void commitDelete(row.id)}
                    >
                      {t("editor.chrome.rightPanel.aiChat.historyDelete")}
                    </Button>
                  </div>
                </div>
              ) : renamingId === row.id ? (
                <div style={ROW_STYLE}>
                  <Input
                    data-testid="agent.hub-rename-input"
                    aria-label={t("common.rename")}
                    value={draft}
                    onChange={(e) => setDraft(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(row.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    data-testid="agent.hub-rename-confirm"
                    onClick={() => void commitRename(row.id)}
                  >
                    {t("common.rename")}
                  </Button>
                </div>
              ) : (
                <div
                  style={{
                    ...ROW_STYLE,
                    cursor: "pointer",
                    // **The card's own edges, so a title can never reach them**
                    // (myne-md/myne#848). A title that ellipsizes needs a flex item
                    // it can shrink inside, and the row has to be able to shrink
                    // with it: without `minWidth: 0` here the title's own
                    // `min-width: 0` never gets free space to give up, so the text
                    // ran to the card's border and was CUT rather than ellipsized.
                    minWidth: 0,
                    // **NO `overflow: hidden` here.** It was added for the title
                    // and it CROPPED the two things that hang off the card: the
                    // three-dot menu is absolutely positioned past the card's
                    // edge, and the rename field renders below it. The title's
                    // ellipsis does not need it, because the title BUTTON carries
                    // its own `overflow: hidden` with `text-overflow: ellipsis`.
                    paddingInline: "var(--space-2)",
                    borderRadius: "var(--radius-1)",
                    // **No border of our own, and the open card is an INSET
                    // ring** (myne-md/myne#848). A hairline box around every row
                    // read as "every card is highlighted"; a ring drawn INSIDE
                    // the open card marks exactly one and cannot reflow the list
                    // by a pixel, which a border would.
                    // A hovered card takes the canon hover ramp (`--bg-3`), so
                    // the pointer finds a row by its surface and not only by the
                    // three-dot button fading in. The open card keeps its own
                    // treatment, which already reads as selected.
                    transition: "background var(--duration-fast) var(--ease-standard)",
                    ...(row.id === activeId
                      ? {
                          background: "var(--bg-2)",
                          boxShadow: "inset 0 0 0 1px var(--accent)",
                        }
                      : hoveredId === row.id
                        ? { background: "var(--bg-3)" }
                        : {}),
                  }}
                  data-testid="agent.hub-card"
                  data-conversation-id={row.id}
                  data-active={row.id === activeId ? "true" : "false"}
                  aria-current={row.id === activeId ? "true" : undefined}
                  data-hover-preview={
                    hoveredId === row.id && hover?.id === row.id && hover.text !== null
                      ? "true"
                      : "false"
                  }
                  onMouseEnter={() => {
                    setHoveredId(row.id);
                    void loadHoverText(row.id);
                  }}
                  onMouseLeave={() => {
                    setHoveredId(null);
                    setMenuId(null);
                  }}
                  // The whole card is the open target, not only its title. The
                  // keyboard path stays on the title button, which is the
                  // accessible name of the row; this is the mouse's larger
                  // target. `stopPropagation` on every inner control keeps a
                  // click on the anchor pill, the menu or an action from also
                  // opening the conversation.
                  onClick={() => void handleOpen(row.id)}
                >
                  <div style={ROW_TOP_STYLE}>
                    {/* **What the conversation is ABOUT** (myne-md/myne#848).
                        Three kinds, in the order the row can be trusted: a
                        folder scope, a note anchor, or neither, the whole
                        vault. `folder` and `note_id` are both optional additive
                        fields on the catalog row, and a conversation carries at
                        most one of them. */}
                    <span
                      // **Three STATIC `t()` call sites, not one computed key**
                      // (myne-md/myne#848). `scripts/check-i18n.mjs` verifies
                      // static call sites, so a key assembled from a variable is
                      // a key it cannot see, and the guard's count dropping is
                      // how that would be noticed at all.
                      aria-label={
                        target === "folder"
                          ? t("agent.hub.targetFolder")
                          : target === "note"
                            ? t("agent.hub.targetNote")
                            : t("agent.hub.targetVault")
                      }
                      data-testid="agent.hub-target"
                      // **`role="img"`, because `aria-label` on a bare
                      // `<span>` is prohibited** (myne-md/myne#848): axe calls
                      // it `aria-prohibited-attr`, and it was caught the moment
                      // this rail got a story, nothing in the app ever ran axe
                      // over it. The glyph IS the announcement here (the label
                      // names the kind of target), which is exactly what an
                      // image role is for; without a role the name was dropped
                      // by every assistive technology and the glyph read as
                      // decoration.
                      role="img"
                      // **One derivation of the kind, three readers**
                      // (myne-md/myne#848): the name, the attribute and the glyph
                      // each spelled the same three-way ternary out again, so a
                      // fourth kind would have been four edits and one of them
                      // would have been missed.
                      data-target={target}
                      style={{
                        display: "inline-flex",
                        flex: "none",
                        color: "var(--fg-3)",
                      }}
                    >
                      <Icon name={TARGET_ICON[target]} size={12} />
                    </span>
                    {/* **The tooltip's trigger is the TITLE's box, not the row's
                        free space** (myne-md/myne#848). It was `stretch`
                        (`flex: 1`), which made the tooltip's wrapper the flexible
                        cell of the row, so its hover area was the empty band
                        between the title and the `...`, and the bubble appeared
                        while the pointer was nowhere near the text.

                        The wrapper here takes `flex: 0 1 auto` instead: it grows
                        to the text, shrinks when the row runs out of room, and the
                        button inside ellipsizes against it. The actions cluster is
                        what holds the right edge, its own
                        `margin-inline-start: auto` absorbs the slack, so nothing
                        needs the title to be the growing cell. */}
                    <span data-testid="agent.hub-title-slot" style={TITLE_SLOT_STYLE}>
                      <Tooltip
                        label={
                          hover?.id === row.id && hover.text !== null
                            ? previewOf(hover.text)
                            : row.title
                        }
                      >
                        <button
                          type="button"
                          data-testid="agent.hub-open"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleOpen(row.id);
                          }}
                          style={TITLE_STYLE}
                        >
                          {row.title}
                        </button>
                      </Tooltip>
                    </span>
                    {/* **The unread mark** (myne-md/myne#848): a dot rather
                        than a count, because one conversation holds at most one
                        finished run and a number would always be 1, the "inbox
                        +1" a user reads is the dot itself. It is drawn at REST,
                        which is what separates it from the `...` cluster beside
                        it: a notification nobody can see without pointing at it
                        is not a notification. The words go to a screen reader,
                        which cannot see a dot. */}
                    {isUnread ? (
                      <span
                        data-testid="agent.hub-unread"
                        style={{ display: "inline-flex", flex: "none" }}
                      >
                        <span aria-hidden="true" style={UNREAD_DOT_STYLE} />
                        <span style={VISUALLY_HIDDEN}>
                          {t("agent.hub.unread")}
                        </span>
                      </span>
                    ) : null}
                    {/* The run mark, beside the title it belongs to. A spinner
                    rather than a word: the rail is 248px and the mark has to sit
                    next to a title that already ellipsizes, so the label is the
                    accessible name and the tooltip (myne-md/myne#848). */}
                    {row.id === runningId ? (
                      <span
                        data-testid="agent.hub-running"
                        // **`role="img"`, or axe drops the name** (myne-md/myne#848):
                        // `aria-label` is prohibited on a bare span, so the
                        // accessible name this mark rests on does not exist without
                        // it. Same fix, same reason, as the target glyph below.
                        role="img"
                        aria-label={t("agent.hub.running")}
                        style={{ display: "flex", flex: "none" }}
                      >
                        <Spinner size={12} />
                      </span>
                    ) : null}
                    {/* **Renaming and deleting moved behind a menu** (myne-md/myne#848).
                        Two always-visible icon buttons per row made a list of
                        titles read as a list of controls, and the two destructive
                        ones were the widest thing on every line. The menu is
                        revealed by hover and by focus: `opacity` rather than
                        `display`, so the trigger stays in the tab order and
                        revealing it on focus is what makes it reachable without
                        a mouse. */}
                    <div
                      // **Only the OPEN row's cluster is the anchor**
                      // (myne-md/myne#848). One ref on every row is one ref
                      // pointing at whichever row rendered last, so the menu was
                      // placed against a row that had nothing to do with the
                      // press. React detaches the ref from the others on the
                      // render that opens this one, so the measurement below sees
                      // exactly this cluster.
                      ref={menuId === row.id ? menuTriggerRef : undefined}
                      style={{
                        ...ROW_ACTIONS_STYLE,
                        opacity:
                          hoveredId === row.id ||
                          menuId === row.id ||
                          row.id === activeId ||
                          // **A RUNNING row shows its controls at rest**
                          // (myne-md/myne#848). The cluster is revealed by
                          // pointing at it, and a run in flight is precisely the
                          // case where the user is looking elsewhere, the run
                          // outlives navigation by design. Hiding the controls
                          // there hid them on the one row whose state the list
                          // is reporting.
                          row.id === runningId
                            ? 1
                            : 0,
                      }}
                      data-testid="agent.hub-row-actions"
                      // The actions cluster swallows clicks so the card's own
                      // handler does not fire on them. Done here rather than on
                      // `IconButton`, whose `onClick` takes no event: a primitive
                      // that started promising an event would change for every
                      // caller to serve one.
                      onClick={(e) => e.stopPropagation()}
                      // Keyboard reveal. Focus events BUBBLE, so a `focusin` from
                      // the trigger inside reaches this wrapper, which is what
                      // keeps the menu reachable without a mouse even though the
                      // cluster is invisible until something points at it.
                      onFocus={() => setHoveredId(row.id)}
                    >
                      <IconButton
                        icon="more-horizontal"
                        iconSize={14}
                        label={t("agent.hub.menu")}
                        tooltip
                        testId="agent.hub-menu"
                        onClick={() => {
                          setRenamingId(null);
                          setDeletingId(null);
                          setMenuId(menuId === row.id ? null : row.id);
                        }}
                      />
                      <AnchoredPanel
                        open={menuId === row.id}
                        onClose={() => setMenuId(null)}
                        anchorRef={menuTriggerRef}
                        style={MENU_STYLE}
                        testId="agent.hub-menu-list"
                      >
                          {/* **A model-written title for the note this
                              conversation is about** (myne-md/myne#848, on the
                              user's ask). Only for a note-anchored
                              conversation: a vault-general one has no note to
                              name, and a folder-scoped one is not ABOUT a note.
                              Disabled rather than hidden when there is no local
                              generation model: the reason goes in its name. The
                              action cannot run anywhere else, because the
                              request class bars a provider, and a control that
                              silently disappears teaches the user nothing about
                              why. */}
                          {row.note_id !== undefined ? (
                            <Button
                              variant="ghost"
                              data-testid="agent.hub-generate-title"
                              disabled={
                                !hasTitleModel ||
                                titleBusyId === row.id ||
                                !titleAllowed
                              }
                              // One reason, in both places: a note in an
                              // excluded folder states that, and a device with
                              // no local model states that. The control stays
                              // rendered rather than disappearing, so the user
                              // learns why the action is not available.
                              aria-label={
                                titleReason ?? t("agent.hub.generateTitle")
                              }
                              title={titleReason ?? undefined}
                              style={MENU_ITEM_STYLE}
                              onClick={() => {
                                setMenuId(null);
                                void generateTitle(row.id, row.note_id!);
                              }}
                            >
                              {t("agent.hub.generateTitle")}
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            data-testid="agent.hub-rename"
                            style={MENU_ITEM_STYLE}
                            onClick={() => {
                              setDeletingId(null);
                              setDraft(row.title);
                              setRenamingId(row.id);
                              setMenuId(null);
                            }}
                          >
                            {t("common.rename")}
                          </Button>
                          <Button
                            variant="ghost"
                            data-testid="agent.hub-delete"
                            style={MENU_ITEM_STYLE}
                            onClick={() => {
                              setRenamingId(null);
                              setDeletingId(row.id);
                              setMenuId(null);
                            }}
                          >
                            {t("editor.chrome.rightPanel.aiChat.historyDelete")}
                          </Button>
                      </AnchoredPanel>
                    </div>
                  </div>
                  <div style={ROW_META_STYLE}>
                    {/* The note the conversation is anchored to, when it is
                    (myne-md/myne#771 story 10). This is what makes "on this
                    note" legible in the Hub, distinct from a vault-general
                    conversation.

                    `.myne-pill`, not the hand-rolled border/radius/padding it
                    was re-deriving — and not `.myne-chiplet`, which it was
                    given first: that class is a 40x28 THEME SWATCH with hidden
                    overflow, so a text label in it is a label nobody can read.
                    Right instinct, wrong class. */}
                    {row.note_id !== undefined ? (
                      // **A `<Tooltip>`, not the native attribute** (myne-md/myne#848):
                      // the same rule the title slot above follows, and the same
                      // wrapper behaviour (the Tooltip's own `minWidth: 0` is what
                      // lets the pill inside ellipsize).
                      <Tooltip label={anchorTitle ?? t("agent.hub.targetNote")}>
                      <button
                        type="button"
                        className="myne-pill"
                        data-interactive={
                          onOpenNote === undefined ? undefined : "true"
                        }
                        data-testid="agent.hub-anchor"
                        data-note-id={row.note_id}
                        disabled={onOpenNote === undefined}
                        // **The note's NAME, not the words "On a note"**
                        // (myne-md/myne#848, on the user's ask). "On a note"
                        // told a reader the KIND of anchor and nothing else, on
                        // the one line where the answer to "which note?" was
                        // available all along: the sidebar's cache holds every
                        // title, and the conversation row carries the id.
                        //
                        // A NAME IS CONTENT, so the question is whether this is
                        // a new disclosure. It is not: the card already renders
                        // the conversation's own title (often a phrase out of
                        // the note), the sidebar beside it renders every note's
                        // title, and the read is an in-memory lookup in the
                        // UNLOCKED editor. Nothing here crosses a boundary,
                        // no IPC, no sync field, no egress, no ACL grant, and
                        // the vault's own titles are not a secret from the
                        // vault's own UI. It is not shown anywhere a locked or
                        // absent vault can see it, because this rail only
                        // exists inside the unlocked editor.
                        //
                        // The full name is the accessible name; the visible text
                        // ellipsizes, because the pill sits in a 248px row beside
                        // the date.
                        aria-label={
                          anchorTitle === null
                            ? t("agent.hub.targetNote")
                            : t("agent.hub.anchorOpen", { name: anchorTitle })
                        }
                        style={ANCHOR_PILL_STYLE}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenNote?.(row.note_id!);
                        }}
                      >
                        <Icon name="link" size={12} />
                        <span style={ANCHOR_TITLE_STYLE}>
                          {anchorTitle ?? t("agent.hub.anchorLabel")}
                        </span>
                      </button>
                      </Tooltip>
                    ) : null}
                    <span style={META_STYLE}>
                      {/* **`updated_at`, or when it is unusable, the create
                          time** (myne-md/myne#848). A row whose timestamp is
                          zero or absent still happened, so the row states when,
                          and a conversation with no date beside it reads as one
                          that was never used. */}
                      {relativeDay(
                        row.updated_at > 0 ? row.updated_at : row.created_at,
                        locale,
                        timeZone,
                      )}
                    </span>

                  {/* **A run in flight says so ON ITS CARD** (myne-md/myne#848).
                      A spinner alone says "something is happening somewhere";
                      what a user scanning the rail needs is the state: that it is
                      still working, and how long. The run belongs to the
                      conversation, so the card is where its state belongs, and
                      it reads the same store the transcript does.

                      **The scope figure came off** (myne-md/myne#848, on the
                      user's read): "can change 431 notes" is the same sentence
                      on every card, because the scope is what the composer was
                      set to, not something about the conversation, and the
                      composer states it two inches below, with the count the
                      decision actually rests on. On the card it was the widest
                      thing on the line and it said nothing a scan needs. */}
                  {row.id === runningId ? (
                    <div
                      data-testid="agent.hub-state"
                      className="myne-working-wave"
                      data-motion="essential"
                      style={RUN_STATE_STYLE}
                    >
                      {/* **One state, one glyph** (myne-md/myne#894). This is the
                          same "working" state the transcript's footprint line
                          renders, and it now uses the same mark: `bot` here and
                          `bot` there made the glyph mean "an assistant" in one
                          place and "a run is in flight" in the other, and in the
                          transcript the two landed on adjacent lines. */}
                      <Icon name="loader-circle" size={12} />
                      <span>{t("agent.progress.working")}</span>
                      {runningSince !== null ? (
                        <>
                          <span aria-hidden="true">&middot;</span>
                          <span>{formatDuration(elapsedMillis ?? 0)}</span>
                        </>
                      ) : null}
                    </div>
                  ) : row.id === agent.runConversationId &&
                    agent.end !== null &&
                    isUnread ? (
                    /* **A finished run says so too, while it is unread**
                       (myne-md/myne#848). This is the card's half of the mark
                       below: the dot says "there is something here", and this
                       says what. It is the same `endStatusLabel` the transcript
                       uses, so a run that stopped to ask for scope reads
                       "Waiting for you" in both places. The change count is the
                       one fact that tells a user whether opening it means
                       reading an answer or reviewing edits. */
                    <div
                      data-testid="agent.hub-done"
                      style={{ ...RUN_STATE_STYLE, color: "var(--accent)" }}
                    >
                      <Icon name="circle-check" size={12} />
                      <span>{endStatusLabel(agent.end.kind, t)}</span>
                      {changes > 0 ? (
                        <>
                          <span aria-hidden="true">&middot;</span>
                          <span style={{ whiteSpace: "nowrap" }}>
                            {t("agent.review.noteHeading", { count: changes })}
                          </span>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {/* **What the title action is doing, on the card it is
                      doing it to** (myne-md/myne#848). A press that ends in
                      nothing is the one outcome a menu item must not have: the
                      note is renamed for the success case (the pill beside it
                      changes), and the two ways it can fail say so here. */}
                  {titleBusyId === row.id ? (
                    <p
                      data-testid="agent.hub-title-busy"
                      style={TITLE_NOTICE_STYLE}
                    >
                      {t("agent.hub.titleGenerating")}
                    </p>
                  ) : titleNotice !== null && titleNotice.id === row.id ? (
                    <p
                      role="alert"
                      data-testid="agent.hub-title-notice"
                      style={{ ...TITLE_NOTICE_STYLE, color: "var(--fg-2)" }}
                    >
                      {t(titleNotice.key)}
                    </p>
                  ) : null}</div>
                </div>
              )}
            </div>
            );
          })}
        </ScrollArea>
      )}
    </div>
  );
}
