// The BK-05 quiet notice: a note saved, but its snapshot did not (#47).
//
// This client really does capture snapshots (`capture_snapshot_best_effort`),
// and until now the failure signal was a bare empty `emit_snapshot_write_failed`
// — so a user kept editing a note whose version history had quietly stopped
// recording, with the designed banner having nothing to render from.
//
// Non-blocking and self-dismissing, like the desktop twin: the save SUCCEEDED,
// and only the undo point is missing. A modal would overstate it; silence
// understated it.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "../platform/event";

/** Backend event name — mirror of `SNAPSHOT_WRITE_FAILED_EVENT` (Rust). */
const SNAPSHOT_WRITE_FAILED_EVENT = "snapshot://write-failed";

/** Long enough to read, short enough not to sit over the note list. */
const AUTO_DISMISS_MS = 8000;

const ROOT: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "10px 12px",
  borderRadius: "var(--radius-2)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-2)",
};

const MSG: CSSProperties = {
  flex: 1,
  fontSize: 13,
  lineHeight: 1.4,
  color: "var(--ink-2)",
};

const DISMISS: CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  font: "inherit",
  fontSize: 12,
  color: "var(--accent)",
  flexShrink: 0,
};

export function SnapshotFailedBanner() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await listen(SNAPSHOT_WRITE_FAILED_EVENT, () => {
          setVisible(true);
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(() => setVisible(false), AUTO_DISMISS_MS);
        });
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Not inside Tauri (browser dev shim) → no backend events.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div role="status" aria-live="polite" style={ROOT} data-testid="snapshot-failed">
      <span style={MSG}>{t("notes.snapshotFailed.message")}</span>
      <button type="button" style={DISMISS} onClick={() => setVisible(false)}>
        {t("common.dismiss")}
      </button>
    </div>
  );
}
