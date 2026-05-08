// Settings → Privacy panel: disabled "Screen-capture protection"
// (enables with MYND-78) + "Auto-lock on idle" (enables with MYND-121
// + MYND-122). Disabled-control discipline per `decisions.md`
// 2026-05-08 — real labels, no "Coming soon" copy.
//
// Penpot canon: `🔴 screen------settings--privacy` (frame id
// `9fb59646-2811-8082-8007-fd1cbf80a20b`).

import type { CSSProperties } from "react";
import {
  BLOCK_STYLE,
  HELPER_STYLE,
  LABEL_STYLE,
  PANEL_ROOT_STYLE,
} from "./panel-styles";

const TOGGLE_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

const TOGGLE_TRACK_STYLE: CSSProperties = {
  position: "relative",
  width: 36,
  height: 20,
  background: "var(--paper-3)",
  border: "1px solid var(--line-2)",
  borderRadius: 10,
  padding: 0,
  cursor: "not-allowed",
  opacity: 0.5,
  flexShrink: 0,
};

const TOGGLE_KNOB_STYLE: CSSProperties = {
  position: "absolute",
  left: 1,
  top: 1,
  width: 16,
  height: 16,
  background: "var(--paper)",
  border: "1px solid var(--line-3)",
  borderRadius: "50%",
};

interface DisabledToggleRowProps {
  label: string;
  ariaLabel: string;
  helper: string;
}

function DisabledToggleRow({ label, ariaLabel, helper }: DisabledToggleRowProps) {
  return (
    <div style={BLOCK_STYLE}>
      <div style={TOGGLE_ROW_STYLE}>
        <span style={LABEL_STYLE}>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={false}
          aria-label={ariaLabel}
          disabled
          style={TOGGLE_TRACK_STYLE}
        >
          <span aria-hidden="true" style={TOGGLE_KNOB_STYLE} />
        </button>
      </div>
      <p style={HELPER_STYLE}>{helper}</p>
    </div>
  );
}

export function PrivacyPanel() {
  return (
    <div style={PANEL_ROOT_STYLE}>
      <DisabledToggleRow
        label="Screen-capture protection"
        ariaLabel="Screen-capture protection (currently unavailable)"
        helper="Other apps' ability to capture this window varies by OS — Phase 1 cannot enforce this protection on all platforms."
      />
      <DisabledToggleRow
        label="Auto-lock on idle"
        ariaLabel="Auto-lock on idle (currently unavailable)"
        helper="Automatically lock the vault after a period of inactivity."
      />
    </div>
  );
}
