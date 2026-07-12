// SY-08 · Sync status detail (MYND-461). Presents the CURRENT sync state from the
// single `use-sync-status` hook + a "Sync now" affordance. A transport-class
// `Error` renders as an honest "Offline — resumes when connected" presentation —
// NOT a raw error for a normal connectivity gap, and NO new `SyncRuntimeStatus`
// enum variant (SYNC-36/Q4). Reached from the note-list header glyph (task 5) and
// MYND-459's Settings → Sync section. Direct-to-code; mobile has no i18n → plain
// strings (no per-device wall-clock strings — SYNC-48).

import type { CSSProperties } from "react";
import { useSyncStatus, type SyncStatus } from "../lib/use-sync-status";

interface Detail {
  dot: string;
  title: string;
  detail: string;
}

function present(status: SyncStatus | null): Detail {
  if (!status) return { dot: "var(--fg-3)", title: "Loading…", detail: "Checking sync status." };
  switch (status.state) {
    case "disabled":
      return { dot: "var(--fg-3)", title: "Sync off", detail: "No server is configured for this account." };
    case "not_enrolled":
      return { dot: "var(--fg-3)", title: "This device isn’t enrolled", detail: "Add this device to your account to start syncing." };
    case "pending":
      return { dot: "var(--accent)", title: "Awaiting approval", detail: "Approve this device from one you’ve already added." };
    case "idle":
      return { dot: "var(--success)", title: "Synced", detail: "Your notes are up to date." };
    case "syncing":
      return { dot: "var(--accent)", title: "Syncing…", detail: "Sending and receiving changes." };
    case "error":
      // A transport-class error is a normal connectivity gap — present it as
      // Offline, never a raw error. Sync resumes automatically on reconnect.
      return { dot: "var(--fg-3)", title: "Offline", detail: "Changes will sync when you reconnect." };
    case "conflicts":
      return {
        dot: "var(--warning)",
        title: `${status.count} conflict${status.count === 1 ? "" : "s"} need review`,
        detail: "Open the conflicts to keep both versions.",
      };
  }
}

const CARD: CSSProperties = {
  border: "1px solid var(--line-1)",
  borderRadius: 10,
  background: "var(--bg-1)",
  padding: "14px 15px",
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const SYNC_NOW: CSSProperties = {
  marginTop: 16,
  width: "100%",
  height: 44,
  border: "1px solid var(--line-1)",
  borderRadius: 10,
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  fontSize: 15,
  fontWeight: 600,
  fontFamily: "var(--font-sans)",
  cursor: "pointer",
};

/** The SY-08 status-detail body (host it in a Sheet / Settings sub-screen). */
export function SyncStatusDetail() {
  const { status, busy, syncNow } = useSyncStatus();
  const { dot, title, detail } = present(status);
  // "Sync now" is only meaningful when there is an authed session to sync — a
  // cycle while disabled / not-enrolled / pending returns NotReady, so hide it
  // there rather than offer a false promise (mirrors the desktop indicator).
  const hideSyncNow =
    status?.state === "disabled" || status?.state === "not_enrolled" || status?.state === "pending";

  return (
    <div data-testid="sync.status-detail" data-sync-state={status?.state ?? "loading"}>
      <div style={CARD}>
        <span
          aria-hidden="true"
          style={{ width: 12, height: 12, borderRadius: "var(--radius-pill)", background: dot, flex: "none" }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }} data-testid="sync.status-detail-title">
            {title}
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 2 }}>{detail}</div>
        </div>
      </div>
      {!hideSyncNow && (
        <button
          type="button"
          style={{ ...SYNC_NOW, opacity: busy ? 0.6 : 1 }}
          onClick={() => void syncNow()}
          disabled={busy}
          data-testid="sync.status-detail-sync-now"
        >
          {busy ? "Syncing…" : "Sync now"}
        </button>
      )}
    </div>
  );
}
