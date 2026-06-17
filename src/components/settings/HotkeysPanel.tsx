// Hotkeys settings panel (hotkeys epic, MYND-304). Lists every bindable command
// grouped (panel-local grouping — grill Q1), shows effective binding(s) as
// glyphs, fuzzy-searches, AND — for rebindable rows — lets the user capture a
// new chord, add/remove bindings, and restore defaults (rebind-flow, #4).
//
// Bindings are the effective projection (override ?? default; SYNC-4) — never
// the registry `kbd`. CodeMirror editor-formatting + literal-Ctrl Ctrl+Tab are
// fixed rows (SYNC-9). Writes go through usePrefs().setKeymapBinding (optimistic
// + nonce-bump → the live engine re-reads). Capture validates (≥1 modifier /
// F-key; capture.ts) and checks conflicts (warn-only, never blocks; conflicts.ts
// / SYNC-7). Visual layout is code-first against design tokens; the canonical
// Penpot frame + visual review is a follow-up (no MCP pairing this pass).

import { useMemo, useState, useEffect, useRef, type CSSProperties } from "react";
import { usePrefs } from "../../hooks/usePrefs";
import { fuzzyFilter } from "../../commands/fuzzy";
import { formatChord } from "../../commands/chord";
import { captureChordFromEvent } from "../../commands/capture";
import { conflictsFor, allConflicts, type ConflictDescriptor } from "../../commands/conflicts";
import { effectiveChords, mergeKeymap } from "../../commands/keymap";
import {
  BINDABLE_COMMANDS,
  BIND_GROUPS,
  catalogDefaults,
  type BindableCommand,
  type BindGroup,
} from "../../commands/bindableCatalog";
import { PANEL_ROOT_STYLE, HELPER_STYLE } from "./panel-styles";

const DEFAULTS = catalogDefaults();
// Conflict descriptors: all rebindable commands (CM-fixed rows are not in the
// rebindable keymap, so they never enter a conflict — SYNC-9). All window-level
// commands share the editor stage + bubble phase except nav.back/forward
// (capture); model that so a capture-phase chord doesn't false-conflict a
// bubble one (SYNC-8).
const DESCRIPTORS: ConflictDescriptor[] = BINDABLE_COMMANDS.filter((c) => c.rebindable).map(
  (c) => ({
    id: c.id,
    scope: {},
    phase: c.id === "nav.back" || c.id === "nav.forward" ? "capture" : "bubble",
  }),
);

const SEARCH_INPUT_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "var(--space-2) var(--space-3)",
  fontSize: "var(--text-base)",
  fontFamily: "var(--font-sans)",
  color: "var(--fg-1)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2, 6px)",
  outline: "none",
};

const GROUP_HEADING_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--fg-3)",
  margin: "var(--space-4) 0 var(--space-2)",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-2) 0",
  borderBottom: "1px solid var(--line-1)",
};

const LABEL_TEXT_STYLE: CSSProperties = { fontSize: "var(--text-base)", color: "var(--fg-1)" };
const CHIPS_WRAP_STYLE: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  alignItems: "center",
  flexWrap: "wrap",
  justifyContent: "flex-end",
};
const CHIP_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1, 4px)",
  padding: "1px var(--space-2)",
  display: "inline-flex",
  gap: "var(--space-1)",
  alignItems: "center",
};
const NOT_SET_STYLE: CSSProperties = { fontSize: "var(--text-sm)", color: "var(--fg-3)", fontStyle: "italic" };
const FIXED_TAG_STYLE: CSSProperties = { fontSize: "var(--text-xs, 11px)", color: "var(--fg-3)" };
const ICON_BTN_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--fg-3)",
  cursor: "pointer",
  fontSize: "var(--text-sm)",
  padding: "0 var(--space-1)",
};
const CAPTURE_INPUT_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--bg-1)",
  border: "1px solid var(--accent, var(--fg-2))",
  borderRadius: "var(--radius-1, 4px)",
  padding: "1px var(--space-2)",
  width: "140px",
};
const WARN_STYLE: CSSProperties = { fontSize: "var(--text-xs, 11px)", color: "var(--warn, #b45309)" };
const RESET_ALL_STYLE: CSSProperties = { ...ICON_BTN_STYLE, color: "var(--fg-2)", alignSelf: "flex-start" };

export function HotkeysPanel() {
  const { prefs, setKeymapBinding } = usePrefs();
  const overrides = prefs.keymap;
  const [query, setQuery] = useState("");
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const captureRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (capturingId) captureRef.current?.focus();
  }, [capturingId]);

  const visible = useMemo(() => {
    const matches = fuzzyFilter(
      BINDABLE_COMMANDS.map((c) => ({ item: c, haystacks: [c.label, c.id, c.group] })),
      query,
    );
    return new Set(matches.map((m) => m.item.id));
  }, [query]);

  // Effective keymap snapshot for conflict checks (override ?? default). The
  // conflict scans below iterate DESCRIPTORS (rebindable only), so the CM-fixed
  // ids in this superset are never examined.
  const effectiveKeymap = useMemo(() => mergeKeymap(DEFAULTS, overrides), [overrides]);

  // Persistent conflict indicator (SYNC-7 / conflict-detection #5): every command
  // sharing a chord+phase+scope with another → flagged in the panel, recomputed live.
  const conflicts = useMemo(() => allConflicts(DESCRIPTORS, effectiveKeymap), [effectiveKeymap]);

  const commit = (cmd: BindableCommand, next: string[] | null) => {
    void setKeymapBinding(cmd.id, next);
  };

  const onCaptureKeyDown = (cmd: BindableCommand) => (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setCapturingId(null);
      setWarning(null);
      return;
    }
    const result = captureChordFromEvent(e.nativeEvent);
    if (!result.ok) {
      // empty reason = still holding a bare modifier; keep listening.
      if (result.reason) setWarning(result.reason);
      return;
    }
    const others = conflictsFor(result.chord, cmd.id, DESCRIPTORS, {
      ...effectiveKeymap,
      [cmd.id]: [...effectiveChords(cmd.id, DEFAULTS, overrides), result.chord],
    });
    if (others.length > 0) {
      const otherLabels = others
        .map((id) => BINDABLE_COMMANDS.find((c) => c.id === id)?.label ?? id)
        .join(", ");
      setWarning(`Already used by ${otherLabels} — added anyway.`);
    } else {
      setWarning(null);
    }
    // Warn-only (SYNC-7): assign regardless. Append (multi-binding).
    const current = effectiveChords(cmd.id, DEFAULTS, overrides);
    if (!current.includes(result.chord)) commit(cmd, [...current, result.chord]);
    setCapturingId(null);
  };

  const removeChord = (cmd: BindableCommand, chord: string) => {
    const next = effectiveChords(cmd.id, DEFAULTS, overrides).filter((c) => c !== chord);
    commit(cmd, next); // [] = explicit unbind
  };

  const resetAll = () => {
    for (const c of BINDABLE_COMMANDS) {
      if (c.rebindable && overrides[c.id] !== undefined) commit(c, null);
    }
    setConfirmResetAll(false);
  };

  return (
    <div style={PANEL_ROOT_STYLE} data-testid="hotkeys.panel">
      <p style={HELPER_STYLE}>
        View and change keyboard shortcuts. Editor formatting and the tab-cycle
        shortcut are fixed.
      </p>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search shortcuts…"
        aria-label="Search shortcuts"
        style={SEARCH_INPUT_STYLE}
        data-testid="hotkeys.search"
      />
      {warning && (
        <span style={WARN_STYLE} data-testid="hotkeys.warning">
          {warning}
        </span>
      )}
      {confirmResetAll ? (
        <span style={WARN_STYLE} data-testid="hotkeys.reset-all-confirm">
          Reset every custom shortcut to its default?{" "}
          <button style={ICON_BTN_STYLE} data-testid="hotkeys.reset-all-yes" onClick={resetAll}>
            Reset all
          </button>
          <button style={ICON_BTN_STYLE} onClick={() => setConfirmResetAll(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          style={RESET_ALL_STYLE}
          data-testid="hotkeys.reset-all"
          onClick={() => setConfirmResetAll(true)}
        >
          Reset all hotkeys…
        </button>
      )}
      {BIND_GROUPS.map((group: BindGroup) => {
        const rows = BINDABLE_COMMANDS.filter((c) => c.group === group && visible.has(c.id));
        if (rows.length === 0) return null;
        return (
          <div key={group} data-testid="hotkeys.group" data-group={group}>
            <h3 style={GROUP_HEADING_STYLE}>{group}</h3>
            {rows.map((cmd) => {
              const effective = effectiveChords(cmd.id, DEFAULTS, overrides);
              const overridden = overrides[cmd.id] !== undefined;
              return (
                <div
                  key={cmd.id}
                  style={ROW_STYLE}
                  data-testid="hotkeys.row"
                  data-command-id={cmd.id}
                  data-rebindable={cmd.rebindable ? "true" : "false"}
                >
                  <span style={LABEL_TEXT_STYLE}>
                    {cmd.label}
                    {conflicts[cmd.id] && (
                      <span
                        style={{ ...WARN_STYLE, marginLeft: "var(--space-2)" }}
                        data-testid="hotkeys.conflict-indicator"
                        title={`Also used by ${conflicts[cmd.id]
                          .map((id) => BINDABLE_COMMANDS.find((c) => c.id === id)?.label ?? id)
                          .join(", ")}`}
                      >
                        ⚠ conflict
                      </span>
                    )}
                  </span>
                  <span style={CHIPS_WRAP_STYLE}>
                    {effective.length === 0 && (
                      <span style={NOT_SET_STYLE} data-testid="hotkeys.binding-empty">
                        Not set
                      </span>
                    )}
                    {effective.map((chord) => (
                      <kbd key={chord} style={CHIP_STYLE}>
                        {formatChord(chord)}
                        {cmd.rebindable && (
                          <button
                            style={ICON_BTN_STYLE}
                            aria-label={`Remove ${formatChord(chord)}`}
                            data-testid="hotkeys.remove-binding"
                            onClick={() => removeChord(cmd, chord)}
                          >
                            ×
                          </button>
                        )}
                      </kbd>
                    ))}
                    {!cmd.rebindable && <span style={FIXED_TAG_STYLE}>fixed</span>}
                    {cmd.rebindable &&
                      (capturingId === cmd.id ? (
                        <input
                          ref={captureRef}
                          readOnly
                          value="Press a key…"
                          style={CAPTURE_INPUT_STYLE}
                          data-testid="hotkeys.capture-input"
                          onKeyDown={onCaptureKeyDown(cmd)}
                          onBlur={() => setCapturingId(null)}
                        />
                      ) : (
                        <>
                          <button
                            style={ICON_BTN_STYLE}
                            data-testid="hotkeys.add-binding"
                            aria-label={`Add a shortcut for ${cmd.label}`}
                            onClick={() => {
                              setWarning(null);
                              setCapturingId(cmd.id);
                            }}
                          >
                            +
                          </button>
                          {overridden && (
                            <button
                              style={ICON_BTN_STYLE}
                              data-testid="hotkeys.reset"
                              aria-label={`Restore default for ${cmd.label}`}
                              onClick={() => commit(cmd, null)}
                            >
                              ↺
                            </button>
                          )}
                        </>
                      ))}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
