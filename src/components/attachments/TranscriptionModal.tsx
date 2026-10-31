// `TranscriptionModal` — the read-only "View transcription" surface for a
// voice-note attachment (voice-to-text MYND-552). It shows the on-device
// transcript the "Transcribe" action wrote to the device-local MYE1 cache
// (`protocol.md` § 9.15), in a scrollable, selectable, read-only region beneath
// the load-bearing fallibility disclaimer.
//
// `AI_TRANSCRIPT_HONESTY_NOTE` is rendered VERBATIM — never i18n'd, pinned by
// E2E full-literal equality (SYNC-V8, load-bearing copy). The transcript itself
// is plaintext (note-body class, AS3-Sensitive); this surface only displays it
// and never re-inserts it into a note (insertion is an explicit editor action,
// SYNC-17). Backdrop, Esc/backdrop dismissal, focus trap + restore, and the
// entry animation all come from `ModalShell`.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "../primitives/ModalShell";
import { AI_TRANSCRIPT_HONESTY_NOTE } from "../../lib/load-bearing-copy";

const BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const FILENAME_STYLE: CSSProperties = {
  margin: 0,
  flex: "0 0 auto",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const DISCLAIMER_STYLE: CSSProperties = {
  margin: 0,
  flex: "0 0 auto",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  color: "var(--fg-3)",
};

const TRANSCRIPT_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  margin: 0,
  padding: "var(--space-3)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.6,
  color: "var(--fg-1)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  userSelect: "text",
};

export function TranscriptionModal({
  open,
  filename,
  text,
  onClose,
}: {
  open: boolean;
  /** The audio attachment's display filename (a subheading in the body). */
  filename: string;
  /** The decrypted transcript text — read-only, selectable. */
  text: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const title = t("attachments.library.transcriptionModalTitle");
  return (
    <ModalShell
      open={open}
      title={title}
      onClose={onClose}
      labelId="attachments-transcription-title"
      closeLabel={t("attachments.library.transcriptionModalClose")}
      width={560}
      height={480}
    >
      <div style={BODY_STYLE} data-testid="attachments.transcription-modal">
        <p style={FILENAME_STYLE} title={filename}>
          {filename}
        </p>
        {/* Load-bearing: rendered verbatim in every locale, pinned by E2E
            full-literal equality (SYNC-V8). Never wrap in t(). */}
        <p
          style={DISCLAIMER_STYLE}
          data-testid="attachments.transcription-disclaimer"
        >
          {AI_TRANSCRIPT_HONESTY_NOTE}
        </p>
        <div
          style={TRANSCRIPT_STYLE}
          data-testid="attachments.transcription-text"
          tabIndex={0}
          role="textbox"
          aria-readonly="true"
          aria-label={title}
        >
          {text}
        </div>
      </div>
    </ModalShell>
  );
}
