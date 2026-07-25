// Settings → Files: the image-OCR opt-out (MYND-441).
//
// OCR is deliberately ON by default and ungated — it is search correctness, not
// an AI feature. This row is the other half of that bargain: a user opening a
// 300-attachment vault on the OCR build will see sustained CPU and battery
// drain, and with no visible cause that reads as "the app broke". One switch
// turns it off.
//
// Turning it off stops the background worker on its next drain; it never deletes
// cached results, so switching back on resumes rather than restarts.
//
// Shape mirrors `LineNumbersSettings` (role="switch" button, optimistic write
// with rollback). Default here is ON, not off, so the initial state is `true`
// until disk says otherwise — reading it as OFF first would flash the wrong
// answer for the overwhelmingly common case.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ControlBlock } from "./ControlBlock";
import { prefsRead, setAttachmentOcrEnabled } from "../../lib/prefs";

const TOGGLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  padding: "6px 12px",
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-2)",
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  cursor: "pointer",
  alignSelf: "flex-start",
};

const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

export function AttachmentOcrSettings() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        setEnabled(p.attachment_ocr_enabled);
      })
      .catch(() => {
        /* locked / no vault — leave the default ON */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean) {
    const prev = enabled;
    setEnabled(next); // optimistic
    try {
      await setAttachmentOcrEnabled(next);
      setError(null);
    } catch {
      setEnabled(prev); // rollback — never leave the UI asserting an unsaved value
      setError(t("settings.attachmentOcr.errorSaveSetting"));
    }
  }

  return (
    <>
      <ControlBlock
        label={t("settings.attachmentOcr.label")}
        helper={t("settings.attachmentOcr.helper")}
        control={
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t("settings.attachmentOcr.label")}
            data-testid="settings.attachment-ocr"
            onClick={() => void toggle(!enabled)}
            style={TOGGLE_STYLE}
          >
            {enabled ? t("settings.attachmentOcr.on") : t("settings.attachmentOcr.off")}
          </button>
        }
      />
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
