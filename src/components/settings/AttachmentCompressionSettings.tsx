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
// Its closing SCOPE sentence is chosen by the `imageCompression` capability,
// because the preference and the transform have different reaches: the
// preference is shared vault content every client reads, writes and syncs
// (`decisions.md` 2026-07-30), while the transform does not run on a client
// that cannot contain a decoder panic. The control therefore stays everywhere —
// a web user turning it off is turning it off for their desktop — but "on every
// device" is false in front of the client that will not honour it, and for a
// feature whose ethical justification is disclosure rather than consent, a
// settings row misdescribing what THIS client does is the wrong end to be loose
// at.
//
// Default state is ON, not off: starting from `false` and correcting after
// the disk read would flash the wrong answer for effectively every vault.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ControlBlock } from "./ControlBlock";
import { Switch } from "../primitives/Switch";
import { has } from "../../platform/capabilities";
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

  const scope = has("imageCompression")
    ? t("settings.attachmentCompression.helperScopeEveryDevice")
    : t("settings.attachmentCompression.helperScopeNotHere");

  return (
    <>
      <ControlBlock
        label={t("settings.attachmentCompression.label")}
        helper={`${t("settings.attachmentCompression.helper")} ${scope}`}
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
