// "Unlinked mentions" section of the backlinks pane (knowledge-graph-ux #2 /
// MYND-196, build-phase v1.1). A collapsed-by-default section BELOW the
// backlinks list: notes whose prose mentions the open note's title without
// `[[wikilink]]`-ing it, each with a one-click "link" action. Reuses the #1
// backlinks reader-surface conventions (count header, card rows, empty state).
//
// The trigger is the SYNC-14 two-tier cost gate (`reduceMentions`): collapsed →
// no work on the vault-change nonce; open → the nonce runs only the CHEAP
// candidate-recall and may raise a "refresh" signal; the expensive decrypt-
// verify runs ONLY on an explicit expand (first open) or refresh. All async work
// is owned here; the reducer just decides which effect to run.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { SECTION_HEADING_STYLE, SIDEBAR_CARD_STYLE } from "./sharedStyles";
import { Icon } from "../../components/primitives/Icon";
import { useIndexNonce } from "../indexNonce";
import type { ResolverNote } from "../resolveWikilink";
import { searchNotes } from "../searchNotes";
import {
  mentionCandidateSignature,
  verifyMentionCandidates,
  type UnlinkedMention,
} from "../unlinkedMentions";
import {
  initialMentionsState,
  reduceMentions,
  type MentionsAction,
  type MentionsEffect,
  type MentionsState,
} from "../unlinkedMentionsController";

type Props = {
  openNoteId: string | null;
  openTitle: string | null;
  notes: ReadonlyArray<ResolverNote>;
  /** Navigate to a mentioning note (mirrors the backlinks card click). */
  onNavigate: (noteId: string) => void;
  /** Insert `[[openTitle]]` into the mentioning note (SYNC-15 buffer-aware
   *  write — MYND-196 task 4). Resolves `true` when a link was written, `false`
   *  on a no-op; both `false` and a rejection restore the optimistically-removed
   *  row so the panel never lies. */
  onLinkMention: (mention: UnlinkedMention) => Promise<boolean>;
  /** Render as a full right-panel tab body (right-panel tabs) rather than a
   *  collapse-by-default sub-section: drop the chevron + collapse affordance
   *  (the tab's active state IS the disclosure) and auto-expand on mount so the
   *  two-tier cost gate runs its verify. Default `false` (legacy nested mode). */
  asTab?: boolean;
};

/**
 * Owns the two-tier controller + the async effects. Returns the view state plus
 * the handlers the section renders against. Kept beside the component (it is UI
 * glue — the testable cost-gate logic is `reduceMentions`, unit-tested).
 */
function useUnlinkedMentions(
  openNoteId: string | null,
  openTitle: string | null,
  notes: ReadonlyArray<ResolverNote>,
  autoExpand: boolean,
) {
  const [state, setState] = useState<MentionsState>(initialMentionsState);
  const [mentions, setMentions] = useState<UnlinkedMention[]>([]);
  const [busy, setBusy] = useState(false);
  const indexNonce = useIndexNonce();

  const stateRef = useRef(state);
  stateRef.current = state;
  // Async generation guard: a note switch bumps this so a stale recall/verify
  // that resolves after the switch is dropped (Tauri invoke is not cancelable).
  const genRef = useRef(0);
  const inputRef = useRef({ openNoteId, openTitle, notes });
  inputRef.current = { openNoteId, openTitle, notes };
  const dispatchRef = useRef<(a: MentionsAction) => void>(() => {});

  const runEffect = useCallback((effect: MentionsEffect) => {
    if (effect === "none") return;
    const { openNoteId, openTitle, notes } = inputRef.current;
    if (openNoteId === null || openTitle === null) return;
    const gen = genRef.current;

    if (effect === "cheap-recall") {
      // The cheap tier: recall candidates, hand the signature to the reducer so
      // it can decide whether to raise the refresh signal. No decrypt.
      void searchNotes(openTitle).then(
        (cands) => {
          if (gen !== genRef.current) return;
          dispatchRef.current({
            type: "candidate-sig",
            sig: mentionCandidateSignature(cands),
          });
        },
        () => {},
      );
      return;
    }

    // effect === "verify": the expensive tier. One recall feeds both the verify
    // and the signature the results are recorded against (no double search).
    setBusy(true);
    void searchNotes(openTitle)
      .then(async (cands) => ({
        found: await verifyMentionCandidates(
          openNoteId,
          openTitle,
          notes,
          cands,
        ),
        sig: mentionCandidateSignature(cands),
      }))
      .then(
        ({ found, sig }) => {
          if (gen !== genRef.current) return;
          setMentions(found);
          setBusy(false);
          dispatchRef.current({ type: "verified", sig });
        },
        () => {
          if (gen !== genRef.current) return;
          setBusy(false);
        },
      );
  }, []);

  const dispatch = useCallback(
    (action: MentionsAction) => {
      const { state: next, effect } = reduceMentions(stateRef.current, action);
      stateRef.current = next;
      setState(next);
      runEffect(effect);
    },
    [runEffect],
  );
  dispatchRef.current = dispatch;

  // A note switch resets the section to collapsed + empty (mentions are
  // note-specific) and invalidates in-flight async.
  useEffect(() => {
    genRef.current += 1;
    stateRef.current = initialMentionsState;
    setState(initialMentionsState);
    setMentions([]);
    setBusy(false);
  }, [openNoteId]);

  // Vault-change nonce → the two-tier reducer decides (collapsed: nothing;
  // open: cheap recall). Runs on mount too — harmlessly (collapsed → "none").
  useEffect(() => {
    dispatch({ type: "nonce" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexNonce]);

  // asTab mode (right-panel tabs): the tab's active state IS the disclosure, so
  // expand on mount and after every note switch — driving the verify tier the
  // way a manual chevron-expand would. Runs AFTER the note-switch reset effect
  // above (which collapsed back to initial), so the expand is honoured fresh.
  useEffect(() => {
    if (autoExpand) dispatch({ type: "expand" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoExpand, openNoteId]);

  const toggle = useCallback(() => {
    dispatch({ type: stateRef.current.expanded ? "collapse" : "expand" });
  }, [dispatch]);

  const refresh = useCallback(() => dispatch({ type: "refresh" }), [dispatch]);

  // Optimistic removal (story 6): drop the row immediately; restore on a write
  // failure so a rejected link doesn't silently vanish.
  const removeOptimistically = useCallback((mention: UnlinkedMention) => {
    setMentions((prev) => prev.filter((m) => m.noteId !== mention.noteId));
  }, []);
  const restore = useCallback((mention: UnlinkedMention) => {
    setMentions((prev) =>
      prev.some((m) => m.noteId === mention.noteId) ? prev : [...prev, mention],
    );
  }, []);

  return {
    expanded: state.expanded,
    refreshAvailable: state.refreshAvailable,
    mentions,
    busy,
    toggle,
    refresh,
    removeOptimistically,
    restore,
  };
}

export function UnlinkedMentionsSection({
  openNoteId,
  openTitle,
  notes,
  onNavigate,
  onLinkMention,
  asTab = false,
}: Props) {
  const { t } = useTranslation();
  const {
    expanded,
    refreshAvailable,
    mentions,
    busy,
    toggle,
    refresh,
    removeOptimistically,
    restore,
  } = useUnlinkedMentions(openNoteId, openTitle, notes, asTab);

  const handleLink = useCallback(
    (mention: UnlinkedMention) => {
      removeOptimistically(mention);
      // Restore the row on a rejection (e.g. the open-dirty guard) AND on a
      // no-op write (`false` — nothing was actually inserted), so the panel
      // never shows a mention as linked when it wasn't.
      void onLinkMention(mention).then(
        (linked) => {
          if (!linked) restore(mention);
        },
        () => restore(mention),
      );
    },
    [onLinkMention, removeOptimistically, restore],
  );

  // No open note → nothing to mention. (The backlinks pane above already shows
  // its own empty state; the section header would be noise.)
  if (openNoteId === null) return null;

  return (
    <div
      // Observability only (`src/AGENTS.md` "Test observability"). This surface
      // carried NO testid at all, which made it invisible to the E2E lane: the
      // `links.backlinks-and-mentions` roster row asks whether the df ceiling
      // engages on a ~25-note corpus, and there was nothing for a scenario to
      // look at. The two `data-*` values are the section's own state, so a
      // scenario asserts what the section IS rather than scraping how it looks
      // — `data-busy` distinguishes "still searching" from "found nothing",
      // which is exactly the pair a settle-time assertion has to tell apart.
      data-testid="editor.unlinked-mentions"
      data-busy={busy ? "true" : "false"}
      data-count={String(mentions.length)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        // As a full tab body the section owns the whole pane, so it drops the
        // nested top border + offset it carried below the backlinks list.
        ...(asTab
          ? {}
          : { marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line-1)" }),
      }}
    >
      {asTab ? (
        // Tab mode: a plain header (no chevron — the active tab IS the disclosure).
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={SECTION_HEADING_STYLE}>
            {t("notes.unlinkedMentions.heading")}
          </span>
          {mentions.length > 0 && (
            <span style={{ fontSize: 12, color: "var(--fg-3)" }}>{mentions.length}</span>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "transparent",
            border: "none",
            padding: 0,
            margin: 0,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <Icon
            name={expanded ? "chevron-down" : "chevron-right"}
            size={14}
            style={{ color: "var(--fg-3)" }}
          />
          <span style={SECTION_HEADING_STYLE}>
            {t("notes.unlinkedMentions.heading")}
          </span>
          {expanded && mentions.length > 0 && (
            <span style={{ fontSize: 12, color: "var(--fg-3)" }}>
              {mentions.length}
            </span>
          )}
        </button>
      )}

      {expanded && (
        <>
          {refreshAvailable && (
            <button
              type="button"
              onClick={refresh}
              style={{
                alignSelf: "flex-start",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
                color: "var(--accent, var(--fg-2))",
              }}
            >
              {t("notes.unlinkedMentions.refresh")}
            </button>
          )}

          {busy ? (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
              {t("notes.unlinkedMentions.searching")}
            </div>
          ) : mentions.length === 0 ? (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
              {t("notes.unlinkedMentions.empty")}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {mentions.map((mention) => (
                <div
                  key={mention.noteId}
                  data-testid="editor.unlinked-mention-row"
                  data-note-id={mention.noteId}
                  style={{
                    ...SIDEBAR_CARD_STYLE,
                    cursor: "default",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "var(--space-2)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onNavigate(mention.noteId)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      textAlign: "start",
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 12,
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--fg-1)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {mention.title || t("common.untitled")}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleLink(mention)}
                    title={t("notes.unlinkedMentions.linkTooltip", {
                      title:
                        openTitle ?? t("notes.unlinkedMentions.thisNote"),
                    })}
                    style={{
                      flexShrink: 0,
                      background: "transparent",
                      border: "1px solid var(--line-1)",
                      borderRadius: 5,
                      padding: "3px 8px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: "var(--text-xs)",
                      color: "var(--fg-2)",
                    }}
                  >
                    {t("notes.unlinkedMentions.link")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
