// A settled agent run's frozen proposal, rendered where it belongs: under the
// turn that proposed it (myne-md/myne#913).
//
// **This replaced a modal.** myne-md/myne#741 moved the diff out of the
// transcript and into a full-width dialog, on the argument that two paragraphs
// of note body under every assistant turn is a 280px bubble of noise. The
// argument was right about the noise and wrong about the place: a diff belongs
// to the message that caused it, and a dialog renders it somewhere the user did
// not come from, over the conversation that explains it. The review card
// (myne-md/myne#894) made the same move in the other direction, and this is the
// last surface that had not.
//
// **Small, and stating what it is.** The trigger is one line in the turn's
// header, and what it opens is a bounded region: a row per note it would have
// changed, with the note's name and its line counts, then the diff itself. The
// region is capped in height rather than in content, so a forty-edit run is
// scrolled instead of being a wall that pushes the composer off screen.
//
// Read-only, deliberately: a frozen proposal may quote a note that has since
// changed, been trashed or moved folders (`chatStore`'s `AgentTurnSummary`
// header). There is no apply and no reject here; the live proposal's controls
// live in `AgentReview`, and a settled one's only affordance is "look at it".
//
// **Nothing about how a diff looks is invented here.** It is the shared
// `<DiffView>` over `diffWithSegments`, in the same `split`-above-560px /
// `unified`-below rule the review card uses (`reviewCardLayout.ts`), because
// the same card sits in a wide pane and a 380px panel and the width is what
// decides.

import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { CAPTION_STYLE } from "./sharedStyles";
import { DiffView } from "./DiffView";
import { useReviewCardNarrow } from "../agent/reviewCardLayout";
import { diffWithSegments } from "../../dialect";
import type { ProposedEdit, ProposedNote } from "../../lib/agent-protocol";

export interface ProposalDiffBodyProps {
  proposal: { edits: ProposedEdit[]; newNotes: ProposedNote[] };
  /** The note's display name, or `null` when it is not in the note set. The
   *  row falls back to the id: a nameless block would be a diff of "something". */
  titleOf?: (noteId: string) => string | null;
}

/** The cap on the whole region. Enough for two or three edits at panel width,
 *  short enough that the transcript and the composer stay in view. */
const BODY_MAX_HEIGHT_PX = 360;

const BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
  maxHeight: BODY_MAX_HEIGHT_PX,
  overflowY: "auto",
  // The turn's own bubble is inset by the transcript; this reads as a region
  // INSIDE it rather than as a second bubble, so it takes the recessed surface.
  padding: "var(--space-2)",
  borderRadius: "var(--radius-1)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
};

const EDIT_BLOCK_STYLE: CSSProperties = {
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const EDIT_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-2) 0",
  minWidth: 0,
};

const EDIT_TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const EDIT_COUNTS_STYLE: CSSProperties = {
  ...CAPTION_STYLE,
  flexShrink: 0,
  fontVariantNumeric: "tabular-nums",
};

export function ProposalDiffBody({ proposal, titleOf }: ProposalDiffBodyProps) {
  const { t } = useTranslation();
  const narrow = useReviewCardNarrow();
  const sections = useMemo(
    () =>
      proposal.edits.map((edit) => {
        const diff = diffWithSegments(edit.anchor, edit.replacement);
        let added = 0;
        let removed = 0;
        for (const line of diff) {
          if (line.type === "add") added += 1;
          else if (line.type === "del") removed += 1;
        }
        return { noteId: edit.noteId, diff, added, removed };
      }),
    [proposal.edits],
  );

  return (
    <div data-testid="ai.proposal-diff-body" style={BODY_STYLE}>
      {sections.map((section, i) => (
        <article
          key={`e${i}`}
          data-testid="ai.proposal-edit"
          data-note-id={section.noteId}
          style={EDIT_BLOCK_STYLE}
        >
          <div style={EDIT_HEADER_STYLE}>
            <span style={EDIT_TITLE_STYLE}>
              {titleOf?.(section.noteId) ?? section.noteId}
            </span>
            <span
              data-testid="ai.proposal-edit-counts"
              data-added={section.added}
              data-removed={section.removed}
              style={EDIT_COUNTS_STYLE}
            >
              {t("agent.proposal.lineCounts", {
                added: section.added,
                removed: section.removed,
              })}
            </span>
          </div>
          <DiffView
            diff={section.diff}
            // The width decides, exactly as it does in the review card: two
            // columns of note text need about 560px, and this region is inside
            // a 380px panel more often than not.
            mode={narrow ? "unified" : "split"}
            leftLabel={t("agent.review.diffCurrent")}
            rightLabel={t("agent.review.diffProposed")}
            style={{ padding: "var(--space-1) var(--space-2) var(--space-2)" }}
          />
        </article>
      ))}
      {proposal.newNotes.map((note, i) => (
        <div
          key={`n${i}`}
          data-testid="ai.proposal-new-note"
          style={EDIT_BLOCK_STYLE}
        >
          <div style={{ ...CAPTION_STYLE, padding: "var(--space-2) var(--space-2) 0" }}>
            {t("editor.chrome.rightPanel.aiChat.historyProposalNewNote")}: {note.title}
          </div>
          <DiffView
            diff={diffWithSegments("", note.body)}
            mode="unified"
            style={{ padding: "var(--space-1) var(--space-2) var(--space-2)" }}
          />
        </div>
      ))}
    </div>
  );
}
