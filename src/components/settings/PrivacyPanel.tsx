// Settings → Privacy panel: interactive "Screen-capture protection"
// toggle (MYND-160 ships persistence) + disabled "Auto-lock on idle"
// (enables with MYND-121 + MYND-122). Disabled-control discipline per
// `decisions.md` 2026-05-08 — real labels, no "Coming soon" copy.
//
// Penpot canon: `screen------settings--privacy` (frame id
// `9fb59646-2811-8082-8007-fd1cbf80a20b`). Visual design ships
// unchanged from MYND-55's disabled-but-ON placeholder per Penpot;
// MYND-160 turns the existing visual into an interactive toggle.

import type { CSSProperties } from "react";
import { usePrefs } from "../../hooks/usePrefs";
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

const TOGGLE_TRACK_BASE_STYLE: CSSProperties = {
  position: "relative",
  width: 36,
  height: 20,
  background: "var(--paper-3)",
  border: "1px solid var(--line-2)",
  borderRadius: 10,
  padding: 0,
  flexShrink: 0,
};

const TOGGLE_TRACK_ON_OVERRIDE: CSSProperties = {
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

// MYND-160 grill Q2.1 disclosure: when the user toggles off, the
// helper text MUST disclose the off-after-unlock semantic so a
// "I turned it off, why is the unlock screen still black?" support
// question is foreseeable + answered at the UI surface. When the
// toggle is on (the default), the helper carries the platform-
// support disclosure inherited from MYND-55/78's disabled placeholder
// copy — modified to drop the "Per-vault toggle ... coming in a
// future release" sentence since the toggle is now interactive.
function screenCaptureHelperText(enabled: boolean): string {
  if (enabled) {
    return "Active on macOS and Windows 10 (May 2020 Update or later). Linux support coming in a future release.";
  }
  return "Protection always applies before unlock. After unlock, follows this preference.";
}

interface ToggleRowProps {
  label: string;
  ariaLabel: string;
  helper: string;
  ariaDescribedBy: string;
  checked: boolean;
  /**
   * When omitted, the toggle is rendered as a disabled placeholder
   * (no `onClick`, `aria-disabled=true`, dimmed visuals). When
   * supplied, the toggle is interactive — `aria-disabled` is omitted,
   * cursor is `pointer`, click fires the callback.
   */
  onToggle?: (next: boolean) => void;
}

function ToggleRow({
  label,
  ariaLabel,
  helper,
  ariaDescribedBy,
  checked,
  onToggle,
}: ToggleRowProps) {
  const interactive = onToggle !== undefined;
  const trackStyle: CSSProperties = {
    ...TOGGLE_TRACK_BASE_STYLE,
    ...(checked ? TOGGLE_TRACK_ON_OVERRIDE : {}),
    cursor: interactive ? "pointer" : "not-allowed",
    opacity: interactive ? 1 : 0.5,
  };
  return (
    <div style={BLOCK_STYLE}>
      <div style={TOGGLE_ROW_STYLE}>
        <span style={LABEL_STYLE}>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-disabled={!interactive}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          onClick={onToggle ? () => onToggle(!checked) : undefined}
          disabled={!interactive}
          style={trackStyle}
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

interface PrivacyPanelProps {
  /**
   * Toast surface — invoked when an optimistic write rolled back
   * (PrefsWriteError on the Rust side). Threaded from
   * `SettingsModal.onShowToast` per the existing AccountPanel
   * pattern. When undefined, errors are silent (acceptable for
   * dev / non-Tauri contexts where the modal mounts without a
   * toast surface wired).
   */
  onShowToast?: (message: string) => void;
}

export function PrivacyPanel({ onShowToast }: PrivacyPanelProps = {}) {
  const { prefs, toggleScreenCapture } = usePrefs(onShowToast);
  return (
    <div style={PANEL_ROOT_STYLE}>
      <ToggleRow
        label="Screen-capture protection"
        ariaLabel="Screen-capture protection"
        ariaDescribedBy="screen-capture-protection-helper"
        helper={screenCaptureHelperText(prefs.screen_capture_protection)}
        checked={prefs.screen_capture_protection}
        onToggle={(next) => {
          void toggleScreenCapture(next);
        }}
      />
      <ToggleRow
        label="Auto-lock on idle"
        ariaLabel="Auto-lock on idle (currently unavailable)"
        ariaDescribedBy="auto-lock-on-idle-helper"
        helper="Automatically lock the vault after a period of inactivity."
        checked={false}
      />
    </div>
  );
}
