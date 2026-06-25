// `<SnapshotFailedIndicator>` — a non-blocking notice shown when a note saved
// successfully but its best-effort pre-overwrite snapshot could not be written
// (MYND-96, SYNC-8). Subscribes to the backend `snapshot://write-failed` event
// and surfaces a brief, dismissable line near the bottom of the editor.
//
// Copy discipline: never blocks editing, and is explicit that the live note is
// safe — only version history may be incomplete. No overclaiming.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

/** Backend event name — mirror of `SNAPSHOT_WRITE_FAILED_EVENT` (Rust). */
const SNAPSHOT_WRITE_FAILED_EVENT = "snapshot://write-failed";
const AUTO_DISMISS_MS = 6000;

const ROOT_STYLE: CSSProperties = {
  position: "fixed",
  right: "var(--space-5)",
  bottom: "var(--space-7)",
  zIndex: 50,
  maxWidth: 340,
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--space-3)",
  padding: "var(--space-3) var(--space-4)",
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-2)",
  lineHeight: 1.45,
};

const MSG_STYLE: CSSProperties = { flex: 1, minWidth: 0 };

const DISMISS_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  margin: 0,
  font: "inherit",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--accent)",
  cursor: "pointer",
  flexShrink: 0,
};

export function SnapshotFailedIndicator() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void listen(SNAPSHOT_WRITE_FAILED_EVENT, () => {
      setVisible(true);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), AUTO_DISMISS_MS);
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div role="status" aria-live="polite" style={ROOT_STYLE}>
      <span style={MSG_STYLE}>{t("notes.snapshotFailed.message")}</span>
      <button
        type="button"
        style={DISMISS_STYLE}
        onClick={() => setVisible(false)}
      >
        {t("notes.snapshotFailed.dismiss")}
      </button>
    </div>
  );
}
