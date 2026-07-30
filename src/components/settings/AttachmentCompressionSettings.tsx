// Settings → Files: the ingest-image-compression opt-out.
//
// Images pasted or dropped into a note are downscaled + re-encoded before
// they are encrypted and stored, so a vault of screenshots doesn't grow
// unbounded on disk, in backups, or over sync. This switch turns that off:
// everything added afterwards is stored exactly as given.
//
// The helper text is deliberately explicit that the transform is
// irreversible — the original bytes are not kept — since that is the one
// fact a user flipping this switch (or deciding not to) needs to know.
//
// Default state is ON, not off: starting from `false` and correcting after
// the disk read would flash the wrong answer for effectively every vault.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ControlBlock } from "./ControlBlock";
import { Switch } from "../primitives/Switch";
import { prefsRead, setAttachmentCompressionEnabled } from "../../lib/prefs";

const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

export function AttachmentCompressionSettings() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        setEnabled(p.attachment_compression_enabled);
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
      await setAttachmentCompressionEnabled(next);
      setError(null);
    } catch {
      setEnabled(prev); // rollback — never leave the UI asserting an unsaved value
      setError(t("settings.attachmentCompression.errorSaveSetting"));
    }
  }

  return (
    <>
      <ControlBlock
        label={t("settings.attachmentCompression.label")}
        helper={t("settings.attachmentCompression.helper")}
        control={
          <Switch
            checked={enabled}
            onChange={(next) => void toggle(next)}
            ariaLabel={t("settings.attachmentCompression.label")}
            testId="settings.attachment-compression"
          />
        }
      />
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
