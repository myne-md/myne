// Settings → Editor: line-number gutter toggle (editor-line-numbers, MYND-314).
// A single `role="switch"` toggle mirroring SpellSettings' control. Self-
// contained like its sibling controls (SpellSettings / TypographySettings):
// local state loaded on mount, disk-first persist with no in-flight gating.
//
// Default OFF (prose-first — the gutter is opt-in). `null` ≡ unset → host
// default-OFF; only an explicit choice is persisted. The setter bumps the prefs
// nonce, so the open editor (its own `usePrefs`) re-reads and reconfigures its
// line-number compartment live (no remount).

import { useEffect, useState, type CSSProperties } from "react";
import { ControlBlock } from "./ControlBlock";
import { prefsRead, setEditorLineNumbers } from "../../lib/prefs";

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

export function LineNumbersSettings() {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        // null ≡ unset → host default-OFF (prose-first).
        setEnabled(p.editor_line_numbers ?? false);
      })
      .catch(() => {
        /* locked / no vault — leave default OFF */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean) {
    const prev = enabled;
    setEnabled(next); // optimistic
    try {
      await setEditorLineNumbers(next);
      setError(null);
    } catch {
      setEnabled(prev); // rollback
      setError("Could not save the line-number setting.");
    }
  }

  return (
    <>
      <ControlBlock
        label="Line numbers"
        helper="Show a line-number gutter in the editor. One number per line; off by default."
        control={
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Line numbers"
            data-testid="settings.line-numbers"
            onClick={() => void toggle(!enabled)}
            style={TOGGLE_STYLE}
          >
            {enabled ? "On" : "Off"}
          </button>
        }
      />
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
