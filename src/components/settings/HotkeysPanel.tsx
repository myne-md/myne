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
// / SYNC-7). Visual layout is built against the design tokens in
// `docs/design/colors_and_type.css`.

import { Fragment, useMemo, useState, useEffect, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { usePrefs } from "../../hooks/usePrefs";
import { fuzzyFilter } from "../../commands/fuzzy";
import { chordTokens, formatChord, isMacPlatform } from "../../commands/chord";
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
import {
  HOVER_TRANSITION,
} from "../primitives/hoverSurface";
import { interactiveSurface, type InteractiveSurfaceHandlers } from "../primitives/interactiveSurface";
import { reservedChord } from "../../platform/keyboard";

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
// The keycap and its remove control, grouped so the × sits OUTSIDE the <kbd>
// instead of reading as part of the chord (#184 part A).
const CHIP_GROUP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
};
// A chord renders as ONE cap PER KEY (`[⌘][K]`), not a single cramped run. The
// old single-<kbd> chip mixed the ⌘/⇧ symbols and the letters in one mono run,
// where the symbols rendered thinner than the letters and jammed together
// (#184 part A). This row holds the per-key caps.
const KEYS_ROW_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
};
// One key cap: a fixed-height, min-width box so every token (⌘, ⇧, a letter) is
// the SAME uniform size and centred; sans (not mono) renders the modifier glyphs
// at a weight closer to the letters; `--paper-3` + `--line-2` + a 1px bottom edge
// give it a legible, raised keycap look.
const KEYCAP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 22,
  height: 22,
  padding: "0 6px",
  boxSizing: "border-box",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
  background: "var(--paper-3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1, 4px)",
  boxShadow: "0 1px 0 var(--line-2)",
  lineHeight: 1,
};
// The "+" between caps on non-mac (Windows/Linux convention: `Ctrl+Shift+G`).
// macOS uses bare glyph caps (`⌘⇧G`) with no separator.
const PLUS_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-xs, 11px)",
};
// The remove control, now a sibling of the keycap. Faint by default, it brightens
// on hover/focus (tokens.css `[data-testid="hotkeys.remove-binding"]`).
const REMOVE_BTN_STYLE: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--fg-3)",
  cursor: "pointer",
  fontSize: "var(--text-sm)",
  lineHeight: 1,
  padding: "0 3px",
  borderRadius: "var(--radius-1, 4px)",
  transition: HOVER_TRANSITION,
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
  borderRadius: "var(--radius-1)",
  transition: HOVER_TRANSITION,
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

// Map each panel-local display group (a typed BindGroup identifier, also used as
// a filter discriminator + data-group attribute) to its translation key. The
// group value stays English in the catalog; only the heading text is localised.
const GROUP_LABEL_KEY: Record<BindGroup, string> = {
  General: "settings.hotkeys.group.general",
  Notes: "settings.hotkeys.group.notes",
  "Panes & Tabs": "settings.hotkeys.group.panesTabs",
  Navigation: "settings.hotkeys.group.navigation",
  View: "settings.hotkeys.group.view",
  "Editor formatting": "settings.hotkeys.group.editorFormatting",
};

/** The remove-binding ×: hover deepens the fill and turns the glyph danger, and a
 *  press confirms the click. The fill half is `interactiveSurface`, which owns the
 *  press step; the colour change chains onto the handlers it returns rather than
 *  spreading around them, because a spread carrying event props placed after a
 *  hand-written handler silently replaces it (`src/AGENTS.md`). Removing a binding
 *  is destructive, which is why the × goes red over a hover rectangle. */
function removeBindingSurface(): InteractiveSurfaceHandlers {
  const surface = interactiveSurface({ hoverBg: "var(--bg-3)" });
  return {
    ...surface,
    onMouseEnter: (e) => {
      surface.onMouseEnter?.(e);
      e.currentTarget.style.color = "var(--danger)";
    },
    onMouseLeave: (e) => {
      surface.onMouseLeave?.(e);
      e.currentTarget.style.color = "var(--fg-3)";
    },
  };
}

export function HotkeysPanel() {
  const { t } = useTranslation();
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
    // Host-reserved chords (MYND-574 task 66). `null` on desktop, so this whole
    // branch is dead there. On web a `hard` reservation is REFUSED rather than
    // bound: the browser acts on the chord and the page cannot stop it, so
    // binding it would produce a shortcut that is visibly configured and does
    // nothing — the failure this task exists to end. The `unreliable` tier is
    // warned about and allowed, matching the panel's existing warn-only conflict
    // policy: it does reach Myne in some browsers, and refusing it would take
    // away a shortcut that works on the machine the user is sitting at.
    //
    // Either way the STORED keymap is untouched on refusal. The keymap syncs
    // (`vault.prefs`), so a web session that "cleaned up" a reserved binding
    // would reach across and break the user's desktop.
    const reserved = reservedChord(result.chord);
    if (reserved?.tier === "hard") {
      setWarning(
        t("settings.hotkeys.reservedRefused", {
          chord: formatChord(result.chord),
          action: t(`settings.hotkeys.reserved.${reserved.actionKey}`),
        }),
      );
      setCapturingId(null);
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
      setWarning(t("settings.hotkeys.warnAlreadyUsed", { commands: otherLabels }));
    } else if (reserved) {
      setWarning(
        t("settings.hotkeys.reservedUnreliable", {
          chord: formatChord(result.chord),
          action: t(`settings.hotkeys.reserved.${reserved.actionKey}`),
        }),
      );
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
    <div
      style={PANEL_ROOT_STYLE}
      data-testid="hotkeys.panel"
      data-setting-anchor="hotkeys.shortcuts"
      data-setting-row="true"
    >
      <p style={HELPER_STYLE}>{t("settings.hotkeys.helper")}</p>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("settings.hotkeys.searchPlaceholder")}
        aria-label={t("settings.hotkeys.searchAriaLabel")}
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
          {t("settings.hotkeys.resetAllConfirm")}{" "}
          <button style={ICON_BTN_STYLE} {...interactiveSurface()} data-testid="hotkeys.reset-all-yes" onClick={resetAll}>
            {t("settings.hotkeys.resetAllYes")}
          </button>
          <button style={ICON_BTN_STYLE} {...interactiveSurface()} onClick={() => setConfirmResetAll(false)}>
            {t("settings.hotkeys.cancel")}
          </button>
        </span>
      ) : (
        <button
          style={RESET_ALL_STYLE}
          {...interactiveSurface()}
          data-testid="hotkeys.reset-all"
          onClick={() => setConfirmResetAll(true)}
        >
          {t("settings.hotkeys.resetAll")}
        </button>
      )}
      {BIND_GROUPS.map((group: BindGroup) => {
        const rows = BINDABLE_COMMANDS.filter((c) => c.group === group && visible.has(c.id));
        if (rows.length === 0) return null;
        return (
          <div key={group} data-testid="hotkeys.group" data-group={group}>
            <h3 style={GROUP_HEADING_STYLE}>{t(GROUP_LABEL_KEY[group])}</h3>
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
                        style={{ ...WARN_STYLE, marginInlineStart: "var(--space-2)" }}
                        data-testid="hotkeys.conflict-indicator"
                        title={t("settings.hotkeys.conflictTitle", {
                          commands: conflicts[cmd.id]
                            .map((id) => BINDABLE_COMMANDS.find((c) => c.id === id)?.label ?? id)
                            .join(", "),
                        })}
                      >
                        {t("settings.hotkeys.conflictIndicator")}
                      </span>
                    )}
                  </span>
                  <span style={CHIPS_WRAP_STYLE}>
                    {effective.length === 0 && (
                      <span style={NOT_SET_STYLE} data-testid="hotkeys.binding-empty">
                        {t("settings.hotkeys.notSet")}
                      </span>
                    )}
                    {effective.map((chord) => {
                      // An existing binding the host takes for itself. It is
                      // NOT removed and NOT rewritten — the keymap syncs, and
                      // this same binding works on the user's desktop. It is
                      // marked, so a shortcut that does nothing here is visibly
                      // accounted for rather than looking broken.
                      const taken = reservedChord(chord);
                      return (
                      <span key={chord} style={CHIP_GROUP_STYLE}>
                        <span
                          style={KEYS_ROW_STYLE}
                          data-testid={taken ? "hotkeys.binding-reserved" : undefined}
                          data-reserved-tier={taken?.tier}
                          title={
                            taken
                              ? t("settings.hotkeys.reservedBadgeTitle", {
                                  chord: formatChord(chord),
                                  action: t(`settings.hotkeys.reserved.${taken.actionKey}`),
                                })
                              : undefined
                          }
                        >
                          {chordTokens(chord).map((tok, i) => (
                            <Fragment key={i}>
                              {i > 0 && !isMacPlatform() && (
                                <span style={PLUS_STYLE}>+</span>
                              )}
                              <kbd style={KEYCAP_STYLE}>{tok}</kbd>
                            </Fragment>
                          ))}
                          {taken && (
                            <span style={{ ...WARN_STYLE, marginInlineStart: "var(--space-1)" }}>
                              {t("settings.hotkeys.reservedBadge")}
                            </span>
                          )}
                        </span>
                        {cmd.rebindable && (
                          <button
                            style={REMOVE_BTN_STYLE}
                            aria-label={t("settings.hotkeys.removeBindingAria", {
                              chord: formatChord(chord),
                            })}
                            data-testid="hotkeys.remove-binding"
                            {...removeBindingSurface()}
                            onClick={() => removeChord(cmd, chord)}
                          >
                            ×
                          </button>
                        )}
                      </span>
                      );
                    })}
                    {!cmd.rebindable && (
                      <span style={FIXED_TAG_STYLE}>{t("settings.hotkeys.fixed")}</span>
                    )}
                    {cmd.rebindable &&
                      (capturingId === cmd.id ? (
                        <input
                          ref={captureRef}
                          readOnly
                          value={t("settings.hotkeys.capturePrompt")}
                          style={CAPTURE_INPUT_STYLE}
                          data-testid="hotkeys.capture-input"
                          onKeyDown={onCaptureKeyDown(cmd)}
                          onBlur={() => setCapturingId(null)}
                        />
                      ) : (
                        <>
                          <button
                            style={ICON_BTN_STYLE}
                            {...interactiveSurface()}
                            data-testid="hotkeys.add-binding"
                            aria-label={t("settings.hotkeys.addBindingAria", {
                              command: cmd.label,
                            })}
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
                              {...interactiveSurface()}
                              data-testid="hotkeys.reset"
                              aria-label={t("settings.hotkeys.restoreDefaultAria", {
                                command: cmd.label,
                              })}
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
