// Settings → Privacy panel: disabled-but-ON "Screen-capture protection"
// (active by default on macOS + Windows 10 build 19041+; per-vault
// toggle enables with MYND-160) + disabled "Auto-lock on idle"
// (enables with MYND-121 + MYND-122). Disabled-control discipline per
// `decisions.md` 2026-05-08 — real labels, no "Coming soon" copy.
//
// Penpot canon: `screen------settings--privacy` (frame id
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

const TOGGLE_TRACK_OFF_STYLE: CSSProperties = {
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

const TOGGLE_TRACK_ON_STYLE: CSSProperties = {
  ...TOGGLE_TRACK_OFF_STYLE,
  background: "var(--accent)",
  border: "1px solid var(--accent-press)",
};

const TOGGLE_KNOB_OFF_STYLE: CSSProperties = {
  position: "absolute",
  left: 1,
  top: 1,
  width: 16,
  height: 16,
  background: "var(--paper)",
  border: "1px solid var(--line-3)",
  borderRadius: "50%",
};

const TOGGLE_KNOB_ON_STYLE: CSSProperties = {
  ...TOGGLE_KNOB_OFF_STYLE,
  left: 18,
  background: "var(--accent-on)",
  border: "none",
};

interface DisabledToggleRowProps {
  label: string;
  ariaLabel: string;
  helper: string;
  checked?: boolean;
  ariaDescribedBy?: string;
}

function DisabledToggleRow({
  label,
  ariaLabel,
  helper,
  checked = false,
  ariaDescribedBy,
}: DisabledToggleRowProps) {
  return (
    <div style={BLOCK_STYLE}>
      <div style={TOGGLE_ROW_STYLE}>
        <span style={LABEL_STYLE}>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-disabled={true}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          disabled
          style={checked ? TOGGLE_TRACK_ON_STYLE : TOGGLE_TRACK_OFF_STYLE}
        >
          <span
            aria-hidden="true"
            style={checked ? TOGGLE_KNOB_ON_STYLE : TOGGLE_KNOB_OFF_STYLE}
          />
        </button>
      </div>
      <p id={ariaDescribedBy} style={HELPER_STYLE}>
        {helper}
      </p>
    </div>
  );
}

export function PrivacyPanel() {
  return (
    <div style={PANEL_ROOT_STYLE}>
      <DisabledToggleRow
        label="Screen-capture protection"
        ariaLabel="Screen-capture protection"
        ariaDescribedBy="screen-capture-protection-helper"
        helper="Active by default on macOS and Windows 10 (May 2020 Update or later). Per-vault toggle and Linux support coming in a future release."
        checked
      />
      <DisabledToggleRow
        label="Auto-lock on idle"
        ariaLabel="Auto-lock on idle (currently unavailable)"
        ariaDescribedBy="auto-lock-on-idle-helper"
        helper="Automatically lock the vault after a period of inactivity."
      />
    </div>
  );
}
