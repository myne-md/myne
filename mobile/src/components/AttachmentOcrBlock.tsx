// The attachment image-OCR switch on mobile (MYND-441, switchable on this
// client since myne-md/myne#880).
//
// # Why this row exists
//
// `attachment_ocr_enabled` is DEVICE-LOCAL (`sync-protocol.md` §10.2) and OCR
// runs IN-PROCESS on this device: the import path injects the shared
// `extract_image_only` (`mobile/src-tauri/src/plugins/attachments/import_mobile.rs`).
// So the device paying the compute cost was the one client that could not turn
// it off, which is the shape backwards. One switch fixes it.
//
// # The switch changes behaviour, not only a stored value
//
// `import_mobile.rs` reads the pref and selects `no_ocr_extract` when it is off
// (`ocr_extractor`), so turning this off really does stop indexing image-only
// attachments. That file's own tests assert the SELECTION, which is what makes
// this a control rather than a stored flag: a row that only wrote the pref would
// pass a value assertion and change nothing.
//
// # Device-local, and the copy says so
//
// A desktop toggle cannot reach a phone, so the choice does not travel and the
// neighbours in this panel are a mix (`attachment_compression_enabled` is
// SHARED). The block states which this is rather than leaving the reader to find
// out on the next sync. Default is ON, matching desktop, and turning it off
// never deletes cached results.
//
// # Optimistic, with a rollback
//
// The write is optimistic like every other row in the sheet, and a rejected
// promise reverts the switch: a control that keeps showing a value the vault
// does not hold is the failure this feature exists to remove.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "./inputs";
import { setAttachmentOcrEnabled } from "../lib/prefs";

const GROUP_STYLE = {
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  overflow: "hidden",
  background: "var(--bg-1)",
} as const;

const ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-3) var(--space-4)",
} as const;

const LABEL_STYLE = {
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
} as const;

const HINT_STYLE = {
  marginTop: "var(--space-3)",
  fontSize: "var(--text-xs)",
  lineHeight: 1.5,
  color: "var(--fg-3)",
} as const;

export function AttachmentOcrBlock({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const [on, setOn] = useState(enabled);

  // Re-seed when the stored value moves underneath (a sync or a sibling write),
  // so the switch never shows a value the vault does not hold.
  useEffect(() => {
    setOn(enabled);
  }, [enabled]);

  const toggle = (next: boolean) => {
    setOn(next); // optimistic
    void setAttachmentOcrEnabled(next).catch(() => setOn(!next)); // rollback
  };

  return (
    <div data-testid="settings.attachmentOcr">
      <div style={GROUP_STYLE}>
        <div style={ROW_STYLE}>
          <span style={LABEL_STYLE}>{t("settings.attachmentOcr.label")}</span>
          {/* `Switch` takes no testId, so the hook hangs on a wrapper. */}
          <span
            data-testid="settings.attachmentOcr.toggle"
            data-on={String(on)}
            style={{ display: "flex", flexShrink: 0 }}
          >
            <Switch on={on} onToggle={() => toggle(!on)} />
          </span>
        </div>
      </div>
      {/* One helper line, the same one desktop prints (owner, 2026-11-08).
          This block used to add two more: "this one is per device" and a
          paragraph about the extracted text being offered as a draft. Both were
          true and both were duplication — the first restates what the toggle's
          own state already means on a phone-only surface, and the second describes
          another screen's behaviour (the draft sheet) inside a settings row. */}
      <div style={HINT_STYLE} data-testid="settings.attachmentOcr.helper">
        {t("settings.attachmentOcr.helper")}
      </div>
    </div>
  );
}
