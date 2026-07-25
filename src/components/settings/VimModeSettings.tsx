// Settings → Editor: vim keyboard-mode toggle (vim-keyboard-mode, MYND-313).
// A single `role="switch"` toggle, the direct sibling of LineNumbersSettings —
// local state loaded on mount, disk-first persist with no in-flight gating.
//
// Default OFF (modal editing is opt-in). `null` ≡ unset → host default-OFF; only
// an explicit choice is persisted. The setter bumps the prefs nonce, so the open
// editor (its own `usePrefs`) re-reads and reconfigures its vim compartment live
// (no remount) — and the engine is only downloaded on the first enable.
//
// The helper copy carries the one honest caveat from the design session: on
// Windows and Linux, Myne's application chords win over vim's `Ctrl-` grammar,
// so a handful of vim chords are unavailable. Stating it here is what keeps a
// missing `Ctrl-d` reading as a documented trade-off rather than a bug report.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ControlBlock } from "./ControlBlock";
import { prefsRead, setEditorVimMode } from "../../lib/prefs";
import { chordPolicyActive } from "../../editor/vim-chords";

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

const CAVEAT_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

export function VimModeSettings() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        // null ≡ unset → host default-OFF (modal editing is opt-in).
        setEnabled(p.editor_vim_mode ?? false);
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
      await setEditorVimMode(next);
      setError(null);
    } catch {
      setEnabled(prev); // rollback
      setError(t("settings.vimMode.errorSaveSetting"));
    }
  }

  return (
    <>
      <ControlBlock
        label={t("settings.vimMode.label")}
        helper={t("settings.vimMode.helper")}
        control={
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t("settings.vimMode.label")}
            data-testid="settings.vim-mode"
            onClick={() => void toggle(!enabled)}
            style={TOGGLE_STYLE}
          >
            {enabled ? t("settings.vimMode.on") : t("settings.vimMode.off")}
          </button>
        }
      />
      {/* The caveat is only true where `Mod` resolves to Ctrl; on macOS vim
          keeps its full Ctrl grammar, so showing it there would be a lie. */}
      {enabled && chordPolicyActive() && (
        <p style={CAVEAT_STYLE} data-testid="settings.vim-mode.caveat">
          {t("settings.vimMode.chordCaveat")}
        </p>
      )}
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
