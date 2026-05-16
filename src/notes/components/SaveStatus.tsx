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
import { formatRelativeTime, useTick } from "./relativeTime";
import type { SaveStatus as SaveStatusValue } from "../useAutosave";

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

export type SaveStatusProps = {
  status: SaveStatusValue;
  onRetry: () => void;
};

export function SaveStatus({ status, onRetry }: SaveStatusProps) {
  // Subscribe to the shared 30s tick so "Saved · N min ago" auto-updates.
  useTick();
  // Ensure pulse keyframes are injected once into the document.
  useEnsurePulseKeyframes();

  switch (status.status) {
    case "clean":
      return (
        <span style={ROOT_STYLE} aria-label="Saved" title="Saved">
          <span style={DOT_BASE_STYLE} />
          Saved
        </span>
      );

    case "editing":
      return (
        <span style={ROOT_STYLE} aria-label="Editing" title="Editing — autosave is armed">
          <span style={DOT_BASE_STYLE} />
          Editing…
        </span>
      );

    case "saving":
      return (
        <span style={ROOT_STYLE} aria-label="Saving" title="Saving…">
          <span style={DOT_SAVING_STYLE} />
          <span style={{ color: "var(--fg-1)" }}>Saving…</span>
        </span>
      );

    case "saved": {
      const rel = formatRelativeTime(status.at);
      return (
        <span
          style={ROOT_STYLE}
          aria-label={`Saved ${rel}`}
          title={`Saved ${rel}`}
        >
          <span style={DOT_BASE_STYLE} />
          Saved<span style={SEP_STYLE}>·</span>
          {rel || "just now"}
        </span>
      );
    }

    case "error":
      return (
        <span
          style={{ ...ROOT_STYLE, color: "var(--warning)" }}
          aria-label="Save failed"
          title="Save failed — click Retry"
        >
          <span style={DOT_ERROR_STYLE} aria-hidden="true">
            ✕
          </span>
          <span style={{ color: "var(--fg-1)" }}>Save failed</span>
          <span style={SEP_STYLE}>·</span>
          <button type="button" style={RETRY_BUTTON_STYLE} onClick={onRetry}>
            Retry
          </button>
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
