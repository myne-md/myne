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
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
      setError(t("settings.focusMode.saveError"));
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
      setError(t("settings.focusMode.saveError"));
    }
  }

  return (
    <>
      <ControlBlock
        label={t("settings.focusMode.typewriterLabel")}
        helper={t("settings.focusMode.typewriterHelper")}
        control={
          <button
            type="button"
            role="switch"
            aria-checked={typewriter}
            aria-label={t("settings.focusMode.typewriterAria")}
            data-testid="settings.focus-typewriter"
            onClick={() => void toggleTypewriter(!typewriter)}
            style={TOGGLE_STYLE}
          >
            {typewriter ? t("settings.focusMode.on") : t("settings.focusMode.off")}
          </button>
        }
      />
      <ControlBlock
        label={t("settings.focusMode.dimLabel")}
        helper={t("settings.focusMode.dimHelper")}
        control={
          <button
            type="button"
            role="switch"
            aria-checked={dim}
            aria-label={t("settings.focusMode.dimAria")}
            data-testid="settings.focus-dim"
            onClick={() => void toggleDim(!dim)}
            style={TOGGLE_STYLE}
          >
            {dim ? t("settings.focusMode.on") : t("settings.focusMode.off")}
          </button>
        }
      />
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
