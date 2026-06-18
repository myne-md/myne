// Settings → Editor: focus-mode behaviours (focus-mode, MYND-348).
// Two `role="switch"` toggles — typewriter scroll + dim inactive lines — that the
// distraction-free focus mode honors. Both default ON; `null` ≡ unset → host
// default-ON. Self-contained like the sibling controls: local state on mount,
// disk-first persist, no in-flight gating.
//
// These configure the focus-mode BEHAVIOUR; entering focus mode itself is the
// ⇧⌘F toggle (ephemeral, not a pref). The setters bump the prefs nonce so an open
// editor re-reads and reconfigures its focus extensions live (no remount).

import { useEffect, useState, type CSSProperties } from "react";
import { ControlBlock } from "./ControlBlock";
import {
  prefsRead,
  setEditorFocusTypewriter,
  setEditorFocusDimInactive,
} from "../../lib/prefs";

const TOGGLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  padding: "6px 12px",
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-2)",
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  cursor: "pointer",
  alignSelf: "flex-start",
};

const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

export function FocusModeSettings() {
  const [typewriter, setTypewriter] = useState(true);
  const [dim, setDim] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        // null ≡ unset → host default-ON.
        setTypewriter(p.editor_focus_typewriter ?? true);
        setDim(p.editor_focus_dim_inactive ?? true);
      })
      .catch(() => {
        /* locked / no vault — leave defaults ON */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleTypewriter(next: boolean) {
    const prev = typewriter;
    setTypewriter(next);
    try {
      await setEditorFocusTypewriter(next);
      setError(null);
    } catch {
      setTypewriter(prev);
      setError("Could not save the focus-mode setting.");
    }
  }

  async function toggleDim(next: boolean) {
    const prev = dim;
    setDim(next);
    try {
      await setEditorFocusDimInactive(next);
      setError(null);
    } catch {
      setDim(prev);
      setError("Could not save the focus-mode setting.");
    }
  }

  return (
    <>
      <ControlBlock
        label="Focus mode · typewriter scroll"
        helper="In focus mode (⇧⌘F), keep the active line vertically centered as you type."
        control={
          <button
            type="button"
            role="switch"
            aria-checked={typewriter}
            aria-label="Typewriter scroll"
            data-testid="settings.focus-typewriter"
            onClick={() => void toggleTypewriter(!typewriter)}
            style={TOGGLE_STYLE}
          >
            {typewriter ? "On" : "Off"}
          </button>
        }
      />
      <ControlBlock
        label="Focus mode · dim inactive lines"
        helper="In focus mode (⇧⌘F), dim every line except the one you're editing."
        control={
          <button
            type="button"
            role="switch"
            aria-checked={dim}
            aria-label="Dim inactive lines"
            data-testid="settings.focus-dim"
            onClick={() => void toggleDim(!dim)}
            style={TOGGLE_STYLE}
          >
            {dim ? "On" : "Off"}
          </button>
        }
      />
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
