// Per-note version history sheet (mobile) — lists a note's encrypted snapshots
// (captured on every edit by MobileHooks), with in-memory preview + an atomic
// undoable restore. Reads through the shared `myne-core` snapshots plugin.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet, Banner, Spinner } from "../../components";
import { snapshotList, snapshotPreview, snapshotRestore, type SnapshotMeta } from "../../lib/snapshots";
import { HAS_TAURI } from "../../lib/app-window";
import { formatBytes } from "../../lib/util";

function formatWhen(ms: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? t("snapshots.today", { time }) : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export function SnapshotsSheet({
  noteId,
  onClose,
  onRestored,
}: {
  noteId: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { t } = useTranslation();
  const [snaps, setSnaps] = useState<SnapshotMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openUuid, setOpenUuid] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!HAS_TAURI) {
      setSnaps([]);
      return;
    }
    setError(null);
    void snapshotList(noteId)
      .then(setSnaps)
      .catch(() => setError(t("snapshots.readError")));
  }, [noteId, t]);
  useEffect(() => load(), [load]);

  async function openPreview(uuid: string) {
    if (openUuid === uuid) {
      setOpenUuid(null);
      return;
    }
    setOpenUuid(uuid);
    setPreviewText(null);
    try {
      setPreviewText(await snapshotPreview(noteId, uuid));
    } catch {
      setPreviewText(null);
      setError(t("snapshots.decryptError"));
    }
  }

  async function restore(uuid: string, close: () => void) {
    setBusy(true);
    try {
      if (HAS_TAURI) await snapshotRestore(noteId, uuid);
      onRestored();
      close();
    } catch {
      setError(t("snapshots.restoreError"));
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose} style={{ maxHeight: "84%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {(close) => (
        <>
          <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)", textAlign: "center", flex: "none" }}>{t("snapshots.title")}</div>

          {error && (
            <div style={{ marginTop: 10, flex: "none" }}>
              <Banner kind="danger">{error}</Banner>
            </div>
          )}

          <div style={{ marginTop: 12, overflowY: "auto", flex: 1, minHeight: 0 }}>
            {snaps === null ? (
              <div style={{ display: "flex", justifyContent: "center", padding: 30 }}>
                <Spinner />
              </div>
            ) : snaps.length === 0 ? (
              <div style={{ textAlign: "center", padding: "30px 20px", color: "var(--fg-3)", fontSize: 14, lineHeight: 1.55 }}>
                {t("snapshots.emptyState")}
              </div>
            ) : (
              snaps.map((s) => (
                <div key={s.snapshot_uuid} style={{ borderTop: "1px solid var(--line-1)" }}>
                  <div
                    onClick={() => void openPreview(s.snapshot_uuid)}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 4px", cursor: "pointer" }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, color: "var(--fg-1)" }}>{formatWhen(s.captured_at_ms, t)}</div>
                      <div style={{ fontSize: 12, color: "var(--fg-3)" }}>{formatBytes(s.size_bytes)}</div>
                    </div>
                    <span style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600, flexShrink: 0 }}>
                      {openUuid === s.snapshot_uuid ? t("snapshots.hide") : t("attachments.library.menuPreview")}
                    </span>
                  </div>
                  {openUuid === s.snapshot_uuid && (
                    <div style={{ padding: "0 4px 12px" }}>
                      <div style={{ maxHeight: 220, overflowY: "auto", background: "var(--bg-2)", border: "1px solid var(--line-1)", borderRadius: 8, padding: 12, fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", color: "var(--fg-2)" }}>
                        {previewText === null ? "…" : previewText || t("snapshots.empty")}
                      </div>
                      <button
                        onClick={() => void restore(s.snapshot_uuid, close)}
                        disabled={busy}
                        style={{ marginTop: 10, width: "100%", height: 44, border: "none", borderRadius: 8, background: "var(--accent)", color: "var(--accent-on)", fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.5 : 1 }}
                      >
                        {t("snapshots.restoreThisVersion")}
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
