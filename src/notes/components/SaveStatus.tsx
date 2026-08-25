// `<SaveStatus>` — BottomBar right-cluster component showing the
// `useAutosave` status. Visual canon: Penpot
// `screen------save-status-states` (frame id
// `01376058-0c2f-8002-8008-0662c3742739`).
//
// PRD stories 49-53 + Q11 (icon + text + live-tick + manual retry).
//
// 5 state renders + narrow-viewport icon-only fallback (~120px text
// budget threshold; falls back to dot/icon + tooltip).

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime, useTick } from "./relativeTime";
import type { SaveStatus as SaveStatusValue } from "../useAutosave";
import { isStorageFull } from "../../lib/storage-pressure";

const ROOT_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-3)",
  maxWidth: 220,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const DOT_BASE_STYLE: CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--fg-3)",
  flexShrink: 0,
};

const DOT_SAVING_STYLE: CSSProperties = {
  ...DOT_BASE_STYLE,
  background: "var(--fg-1)",
  animation: "myne-save-pulse 1.2s ease-in-out infinite",
};

const DOT_ERROR_STYLE: CSSProperties = {
  ...DOT_BASE_STYLE,
  width: 8,
  height: 8,
  borderRadius: 0,
  background: "transparent",
  position: "relative",
};

const RETRY_BUTTON_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  margin: 0,
  font: "inherit",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--accent)",
  textDecoration: "underline",
  cursor: "pointer",
};

const SEP_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  margin: "0 4px",
};

/** Unsynced-edit marker (phase3-web-client task 23) — the hollow ring the
 *  sidebar row uses, repeated here so the state is visible while the sidebar is
 *  collapsed. Same shape and same ink deliberately: two glyphs for one fact
 *  would read as two facts. */
const UNSYNCED_MARK_STYLE: CSSProperties = {
  display: "inline-block",
  boxSizing: "border-box",
  width: 6,
  height: 6,
  borderRadius: "50%",
  border: "1px solid var(--fg-3)",
  background: "transparent",
  flexShrink: 0,
};

export type SaveStatusProps = {
  status: SaveStatusValue;
  onRetry: () => void;
  /**
   * Whether the note this readout describes is **not yet on the server**
   * (phase3-web-client task 23).
   *
   * Rendered as a trailing marker rather than as a sixth `status` value, because
   * it is an orthogonal fact and folding it in would make the two mutually
   * exclusive: "Saved" and "not on the server" are simultaneously true for every
   * note in the seconds after a save, and that combination is exactly the one
   * the user needs to be able to see.
   */
  unsynced?: boolean;
};

export function SaveStatus({ status, onRetry, unsynced = false }: SaveStatusProps) {
  const { t } = useTranslation();
  // Sits OUTSIDE the readout rather than inside one of its six branches: the
  // save state and the sync state are independent, and every branch would
  // otherwise need the same trailing node.
  return (
    <>
      <SaveStatusReadout status={status} onRetry={onRetry} />
      {unsynced && (
        <span
          style={UNSYNCED_MARK_STYLE}
          data-testid="editor.unsynced-marker"
          title={t("notes.row.unsyncedTitle")}
          aria-label={t("notes.row.unsyncedLabel")}
        />
      )}
    </>
  );
}

function SaveStatusReadout({ status, onRetry }: { status: SaveStatusValue; onRetry: () => void }) {
  const { t } = useTranslation();
  // Subscribe to the shared 30s tick so "Saved · N min ago" auto-updates.
  useTick();
  // Ensure pulse keyframes are injected once into the document.
  useEnsurePulseKeyframes();

  switch (status.status) {
    case "clean":
      return (
        <span
          data-testid="editor.save-status"
          style={ROOT_STYLE}
          aria-label={t("notes.saveStatus.saved")}
          title={t("notes.saveStatus.saved")}
        >
          <span style={DOT_BASE_STYLE} />
          {t("notes.saveStatus.saved")}
        </span>
      );

    case "editing":
      return (
        <span
          data-testid="editor.save-status"
          style={ROOT_STYLE}
          aria-label={t("notes.saveStatus.editing")}
          title={t("notes.saveStatus.editingTitle")}
        >
          <span style={DOT_BASE_STYLE} />
          {t("notes.saveStatus.editingEllipsis")}
        </span>
      );

    case "saving":
      return (
        <span
          data-testid="editor.save-status"
          style={ROOT_STYLE}
          aria-label={t("notes.saveStatus.saving")}
          title={t("notes.saveStatus.savingEllipsis")}
        >
          <span style={DOT_SAVING_STYLE} />
          <span style={{ color: "var(--fg-1)" }}>
            {t("notes.saveStatus.savingEllipsis")}
          </span>
        </span>
      );

    case "saved": {
      const rel = formatRelativeTime(status.at);
      return (
        <span
          data-testid="editor.save-status"
          style={ROOT_STYLE}
          aria-label={t("notes.saveStatus.savedRelative", { rel })}
          title={t("notes.saveStatus.savedRelative", { rel })}
        >
          <span style={DOT_BASE_STYLE} />
          {t("notes.saveStatus.saved")}
          <span style={SEP_STYLE}>·</span>
          {rel || t("notes.saveStatus.justNow")}
        </span>
      );
    }

    case "error": {
      // Storage exhaustion gets its own words (phase3-web-client task 91).
      // "Save failed: click Retry" is advice that cannot work while the disk or
      // the origin's quota is full: the user would retry forever. And the
      // sentence that matters most is the one a generic failure never says —
      // an edit that could not be written locally is **also not on the server**,
      // so there is no second copy waiting to be recovered.
      const full = isStorageFull(status.error);
      return (
        <span
          data-testid="editor.save-status"
          data-storage-full={full ? "true" : undefined}
          style={{ ...ROOT_STYLE, color: "var(--warning)" }}
          aria-label={t(full ? "notes.saveStatus.storageFull" : "notes.saveStatus.saveFailed")}
          title={t(
            full ? "notes.saveStatus.storageFullTitle" : "notes.saveStatus.saveFailedTitle",
          )}
        >
          <span style={DOT_ERROR_STYLE} aria-hidden="true">
            ✕
          </span>
          <span style={{ color: "var(--fg-1)" }}>
            {t(full ? "notes.saveStatus.storageFull" : "notes.saveStatus.saveFailed")}
          </span>
          <span style={SEP_STYLE}>·</span>
          <button type="button" style={RETRY_BUTTON_STYLE} onClick={onRetry}>
            {t("notes.saveStatus.retry")}
          </button>
        </span>
      );
    }

    // §11.3 keep-both in flight: the save lost to a sync pull; the buffer is
    // being preserved as a conflict copy and the pane re-based. Transient —
    // ends `clean` once the pulled body is adopted. Same pulsing affordance
    // as `saving` (work is happening, no action needed).
    case "conflict":
      return (
        <span
          data-testid="editor.save-status"
          style={ROOT_STYLE}
          aria-label={t("notes.saveStatus.conflict")}
          title={t("notes.saveStatus.conflictTitle")}
        >
          <span style={DOT_SAVING_STYLE} />
          <span style={{ color: "var(--fg-1)" }}>
            {t("notes.saveStatus.conflict")}
          </span>
        </span>
      );
  }
}

// Pulse keyframes — inject once into `document.head` so the `saving`
// dot can use a CSS-driven animation without requiring a global
// stylesheet edit. Idempotent: a second mount detects the existing
// node and skips.

const PULSE_STYLE_ID = "myne-save-pulse-keyframes";
const PULSE_KEYFRAMES = `@keyframes myne-save-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}`;

function useEnsurePulseKeyframes() {
  const [injected, setInjected] = useState(false);
  useEffect(() => {
    if (injected) return;
    if (typeof document === "undefined") return;
    if (document.getElementById(PULSE_STYLE_ID) !== null) {
      setInjected(true);
      return;
    }
    const node = document.createElement("style");
    node.id = PULSE_STYLE_ID;
    node.textContent = PULSE_KEYFRAMES;
    document.head.appendChild(node);
    setInjected(true);
  }, [injected]);
}
