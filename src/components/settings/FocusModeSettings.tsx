// Settings → Editor: focus-mode behaviours (focus-mode, MYND-348).
// Two `<Switch>` toggles — typewriter scroll + dim inactive lines — that the
// distraction-free focus mode honors. Both default ON; `null` ≡ unset → host
// default-ON. Self-contained like the sibling controls: local state on mount,
// disk-first persist, no in-flight gating.
//
// These configure the focus-mode BEHAVIOUR; entering focus mode itself is the
// ⇧⌘F toggle (ephemeral, not a pref). The setters bump the prefs nonce so an open
// editor re-reads and reconfigures its focus extensions live (no remount).

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import { ControlBlock } from "./ControlBlock";
import {
  prefsRead,
  setEditorFocusTypewriter,
  setEditorFocusDimInactive,
} from "../../lib/prefs";

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
          <Switch
            checked={typewriter}
            onChange={() => toggleTypewriter(!typewriter)}
            ariaLabel={t("settings.focusMode.typewriterAria")}
            testId="settings.focus-typewriter"
          />
        }
      />
      <ControlBlock
        label={t("settings.focusMode.dimLabel")}
        helper={t("settings.focusMode.dimHelper")}
        control={
          <Switch
            checked={dim}
            onChange={() => toggleDim(!dim)}
            ariaLabel={t("settings.focusMode.dimAria")}
            testId="settings.focus-dim"
          />
        }
      />
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
