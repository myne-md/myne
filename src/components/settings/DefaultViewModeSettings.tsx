// Settings → Editor: default view mode (reading-source-modes, MYND-299).
// A three-way segmented control (Live preview / Reading / Source) persisting the
// `editor_default_view_mode` pref. Uses the shared `Segmented` primitive (like the
// sibling TypographySettings rows) for a consistent look + E2E hooks. Self-
// contained: local state loaded on mount, disk-first persist, no in-flight gating.
//
// Default "live" (prose-first live-preview). `null` ≡ unset → host default-live;
// only an explicit choice is persisted (live persists as null for byte-stable
// omit-when-default). The setter bumps the prefs nonce, so a newly-opened tab
// picks up the new default (open tabs keep their per-tab mode).

import { useEffect, useState, type CSSProperties } from "react";
import { ControlBlock } from "./ControlBlock";
import { Segmented } from "../primitives/Segmented";
import { prefsRead, setEditorDefaultViewMode } from "../../lib/prefs";
import { asViewMode, type ViewMode } from "../../editor/view-mode";

const OPTIONS = [
  { value: "live", label: "Live preview" },
  { value: "reading", label: "Reading" },
  { value: "source", label: "Source" },
] as const;

const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

export function DefaultViewModeSettings() {
  const [mode, setMode] = useState<ViewMode>("live");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        setMode(asViewMode(p.editor_default_view_mode));
      })
      .catch(() => {
        /* locked / no vault — leave default live */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(next: ViewMode) {
    const prev = mode;
    setMode(next); // optimistic
    try {
      // "live" is the default — persist it as unset (null) to keep byte-stable
      // omit-when-default; reading/source persist the explicit value.
      await setEditorDefaultViewMode(next === "live" ? null : next);
      setError(null);
    } catch {
      setMode(prev); // rollback
      setError("Could not save the default view mode.");
    }
  }

  return (
    <>
      <ControlBlock
        label="Default view mode"
        helper="How a note opens: Live preview (default), read-only Reading, or raw Source. Toggle a note with ⇧⌘E."
        control={
          <Segmented
            options={OPTIONS}
            value={mode}
            onChange={(v) => void choose(v as ViewMode)}
            ariaLabel="Default view mode"
            testId="settings.default-view-mode"
          />
        }
      />
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
