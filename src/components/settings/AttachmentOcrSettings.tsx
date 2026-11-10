// Settings → Files: the image-OCR opt-out (MYND-441).
//
// OCR is deliberately ON by default and ungated — it is search correctness, not
// an AI feature. This row is the other half of that bargain: a user opening a
// 300-attachment vault on the OCR build will see sustained CPU and battery
// drain, and with no visible cause that reads as "the app broke". One switch
// turns it off.
//
// The switch gates BOTH paths — the background worker and the eager extraction
// that runs at import — so turning it off really does stop all OCR, rather than
// only the part that happens to be visible. It never deletes cached results, so
// switching back on resumes rather than restarts.
//
// Default state is ON, not off: starting from `false` and correcting after the
// disk read would flash the wrong answer for effectively every vault.
import { useEffect, useState } from "react";
import { listen } from "../../platform/event";
import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { HELPER_STYLE } from "./panel-styles";
import { Switch } from "../primitives/Switch";
import { usePrefValue } from "@myne/client-core/pref-value";
import {
  OCR_BACKLOG_PROGRESS_EVENT,
  prefsRead,
  setAttachmentOcrEnabled,
  type OcrBacklogProgress,
} from "../../lib/prefs";

export function AttachmentOcrSettings() {
  const { t } = useTranslation();
  const { value: enabled, set: setEnabled, error } = usePrefValue({
    read: prefsRead,
    select: (p) => p.attachment_ocr_enabled,
    write: setAttachmentOcrEnabled,
    initial: true,
    errorMessage: t("common.couldnotsavethissetting"),
  });
  // Attachments still queued. `0` hides the line — the indicator exists to
  // explain a busy fan, so it must disappear the moment there is nothing to
  // explain.
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    // The worker emits at start, after every attachment, and once at the end
    // with `remaining: 0`, so this needs no polling and no timer.
    const stop = listen<OcrBacklogProgress>(OCR_BACKLOG_PROGRESS_EVENT, (e) =>
      setRemaining(e.payload.remaining),
    );
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, []);


  return (
    <SettingRow
      label={t("settings.attachmentOcr.label")}
      helper={t("settings.attachmentOcr.helper")}
      error={error}
      control={(helperId) => (
        <Switch
          checked={enabled}
          onChange={(next) => void setEnabled(next)}
          ariaLabel={t("settings.attachmentOcr.label")}
          ariaDescribedBy={helperId}
          testId="settings.attachment-ocr"
        />
      )}
    >
      {remaining > 0 && (
        <p style={HELPER_STYLE} data-testid="settings.attachment-ocr-progress">
          {t("settings.attachmentOcr.processing", { count: remaining })}
        </p>
      )}
    </SettingRow>
  );
}
