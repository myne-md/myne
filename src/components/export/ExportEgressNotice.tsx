// The plaintext-egress disclosure for the DOWNLOAD delivery path
// (phase3-web-client task 98).
//
// # What this replaces, and why it is a modal at all
//
// Myne states its plaintext egress plainly, exactly once, at the decision
// point. On desktop that "once" is usually the OS save dialog's title — the
// sentence is on screen while the user is still choosing whether and where, and
// dismissing costs nothing. That is a good disclosure precisely because it is
// *ahead* of the bytes and *free* to refuse.
//
// A browser download has neither property. `deliverFile` resolves with the file
// already handed to the browser; there is no title to carry a sentence and no
// step to back out of. Without something here, the no-modal export paths — the
// common ones, a note with no attachments — would ship plaintext with nothing
// said at all.
//
// So this is the browser's stand-in for the dialog title: same sentence, same
// position in the flow, same free exit. It is NOT a warning and must not grow
// into one. The tone is the dialog title's, not an alert's — PRODUCT.md, and
// `threat-model.md` TB3, which makes export a deliberate, sanctioned exception
// rather than something to talk the user out of.
//
// # The sentence is rendered verbatim and is not translated
//
// `sentence` is a `load-bearing-copy.ts` constant passed in by the flow. Its
// exact wording is a privacy property, E2E-pinned by full-literal equality, and
// rendered identically in every locale (`src/AGENTS.md` "Do NOT i18n
// load-bearing copy"). Only the chrome around it — title, buttons — is
// translated. A future editor who "fixes" the untranslated paragraph breaks the
// property; the test asserting full-string equality is what catches it.

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useOverlayInert } from "../../hooks/useOverlayInert";
import { Button } from "../primitives/Button";
import {
  BACKDROP_STYLE,
  CARD_STYLE,
  FOOTER_STYLE,
  SENTENCE_STYLE,
  TITLE_STYLE,
} from "./NoteExportModal";

interface ExportEgressNoticeProps {
  open: boolean;
  /** The load-bearing egress sentence for the format being exported.
   *  Rendered VERBATIM — never through `t()`, never reworded. */
  sentence: string;
  /** Free exit — Cancel, Esc, backdrop. Nothing is delivered. */
  onCancel: () => void;
  /** Proceed: the bytes go to the browser's download. */
  onConfirm: () => void;
}

export function ExportEgressNotice({
  open,
  sentence,
  onCancel,
  onConfirm,
}: ExportEgressNoticeProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  // The rest of the page goes INERT while this is open (myne-md/myne#728).
  // The focus trap above contains Tab; it does not stop a screen reader's
  // virtual cursor reading the page behind, and `aria-modal` is an assertion
  // some assistive technology ignores. Registered on the BACKDROP, which is
  // the whole overlay: registering the card would inert the backdrop it is in.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, open);
  useFocusTrap(dialogRef, { enabled: open });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-egress-title"
      style={BACKDROP_STYLE}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div ref={dialogRef} style={CARD_STYLE} data-testid="export.egress-notice">
        <h2 id="export-egress-title" style={TITLE_STYLE}>
          {t("export.egress.title")}
        </h2>
        <p style={SENTENCE_STYLE} data-testid="export.egress-sentence">
          {sentence}
        </p>
        <div style={FOOTER_STYLE}>
          <Button
            variant="secondary"
            style={{ height: 36 }}
            onClick={onCancel}
            data-testid="export.egress-cancel"
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            style={{ height: 36 }}
            onClick={onConfirm}
            data-testid="export.egress-confirm"
          >
            {t("export.egress.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}
