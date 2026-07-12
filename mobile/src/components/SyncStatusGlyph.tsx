// Note-list header sync-status glyph (SY-01, MYND-461). A glanceable, tappable
// glyph off the single `use-sync-status` hook: synced is quiet, syncing spins,
// error takes the danger tint, conflicts show a subtle count. Tapping it opens
// the SY-08 status detail screen (task 6, wired via `onOpenDetail`). Built
// directly against design tokens + gallery-mock authority — the owner deferred
// the Penpot mobile page and directed direct-to-code (SYNC-48). Mobile has no
// i18n layer, so copy is plain English (the aria-label / title).

import type { CSSProperties } from "react";
import { useSyncStatus, type SyncStatus } from "../lib/use-sync-status";

interface GlyphView {
  color: string;
  spin: boolean;
  count?: number;
  label: string;
}

function view(status: SyncStatus | null): GlyphView {
  if (!status) return { color: "var(--fg-3)", spin: false, label: "Sync: loading" };
  switch (status.state) {
    case "disabled":
      return { color: "var(--fg-3)", spin: false, label: "Sync off" };
    case "not_enrolled":
      return { color: "var(--fg-3)", spin: false, label: "Sync: this device is not enrolled" };
    case "pending":
      return { color: "var(--accent)", spin: false, label: "Sync: awaiting approval" };
    case "idle":
      return { color: "var(--success)", spin: false, label: "Synced" };
    case "syncing":
      return { color: "var(--accent)", spin: true, label: "Syncing…" };
    case "error":
      return { color: "var(--danger)", spin: false, label: "Sync error" };
    case "conflicts":
      return {
        color: "var(--warning)",
        spin: false,
        count: status.count,
        label: `Sync: ${status.count} conflict${status.count === 1 ? "" : "s"} to resolve`,
      };
  }
}

const BTN: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 32,
  height: 32,
  padding: "0 4px",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  flexShrink: 0,
};

export interface SyncStatusGlyphProps {
  /** Open the SY-08 status detail screen (task 6). */
  onOpenDetail?: () => void;
}

export function SyncStatusGlyph({ onOpenDetail }: SyncStatusGlyphProps) {
  const { status } = useSyncStatus();
  const { color, spin, count, label } = view(status);

  return (
    <button
      type="button"
      style={BTN}
      onClick={onOpenDetail}
      aria-label={label}
      title={label}
      data-testid="sync.header-glyph"
      data-sync-state={status?.state ?? "loading"}
    >
      {spin ? (
        // Spinning ring for the in-flight `syncing` state — reuses the global
        // `myne-spinner-rotate` keyframe from `styles/tokens.css`.
        <span
          aria-hidden="true"
          style={{
            width: 14,
            height: 14,
            borderRadius: "var(--radius-pill)",
            border: "2px solid var(--line-1)",
            borderTopColor: color,
            animation: "myne-spinner-rotate 0.9s linear infinite",
          }}
        />
      ) : (
        // Quiet status dot for every steady state.
        <span
          aria-hidden="true"
          style={{
            width: 9,
            height: 9,
            borderRadius: "var(--radius-pill)",
            background: color,
          }}
        />
      )}
      {count !== undefined && count > 0 && (
        <span
          data-testid="sync.header-glyph-count"
          style={{
            marginInlineStart: 3,
            fontSize: 11,
            fontWeight: 600,
            color: "var(--warning)",
            fontFamily: "var(--font-sans)",
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}
