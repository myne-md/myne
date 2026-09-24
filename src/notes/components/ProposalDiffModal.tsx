// Read-only diff of a settled agent run's frozen proposal (myne-md/myne#741).
//
// Replaces the inline Before/After blocks that used to render under every
// assistant turn. Those put two paragraphs of note body in a 280px sidebar
// bubble on every open; this opens one modal with the same proposal painted
// through the shared `<DiffView>`, which is how the review screen already
// shows an edit.
//
// **Deliberately not the review screen.** No apply, no reject, no per-row
// controls: a frozen proposal may quote a note that has since changed, been
// trashed, or moved folders (`chatStore`'s `AgentTurnSummary` header). The
// only affordance is close.

import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/primitives/ModalShell";
import { CAPTION_STYLE } from "./sharedStyles";
import { DiffView } from "./DiffView";
import { diffWithSegments } from "../../dialect";
import type { ProposedEdit, ProposedNote } from "../../lib/agent-protocol";

export interface ProposalDiffModalProps {
  open: boolean;
  onClose: () => void;
  proposal: { edits: ProposedEdit[]; newNotes: ProposedNote[] };
}

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  overflowY: "auto",
  padding: "var(--space-3) var(--space-5)",
  minHeight: 0,
};

const EDIT_BLOCK_STYLE: CSSProperties = {
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const EDIT_BODY_STYLE: CSSProperties = {
  flex: "0 0 auto",
  overflow: "visible",
  padding: "var(--space-2) var(--space-3)",
};

export function ProposalDiffModal({ open, onClose, proposal }: ProposalDiffModalProps) {
  const { t } = useTranslation();
  const sections = useMemo(
    () =>
      proposal.edits.map((edit) => ({
        noteId: edit.noteId,
        diff: diffWithSegments(edit.anchor, edit.replacement),
      })),
    [proposal.edits],
  );

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={t("editor.chrome.rightPanel.aiChat.diffTitle")}
      labelId="ai-proposal-diff-title"
      width={720}
      closeLabel={t("common.close")}
      testId="ai.proposal-diff"
    >
      <div data-testid="ai.proposal-diff-body" style={SECTION_STYLE}>
        {sections.map((section, i) => (
          <article
            key={`e${i}`}
            data-testid="ai.proposal-edit"
            data-note-id={section.noteId}
            style={EDIT_BLOCK_STYLE}
          >
            <DiffView
              diff={section.diff}
              mode="split"
              leftLabel={t("agent.review.diffCurrent")}
              rightLabel={t("agent.review.diffProposed")}
              style={EDIT_BODY_STYLE}
            />
          </article>
        ))}
        {proposal.newNotes.map((note, i) => (
          <div
            key={`n${i}`}
            data-testid="ai.proposal-new-note"
            style={EDIT_BLOCK_STYLE}
          >
            <div style={{ ...CAPTION_STYLE, padding: "var(--space-2) var(--space-3) 0" }}>
              {t("editor.chrome.rightPanel.aiChat.historyProposalNewNote")}: {note.title}
            </div>
            <DiffView
              diff={diffWithSegments("", note.body)}
              mode="unified"
              style={EDIT_BODY_STYLE}
            />
          </div>
        ))}
      </div>
    </ModalShell>
  );
}
