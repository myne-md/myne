// Settings → Editor panel: note-authoring behaviour preferences that are not
// visual — spell-check (toggle + language picker, MYND-267) and daily-notes
// configuration (folder / date-format / template, MYND-191). Both moved here
// from the Appearance panel, which had become a grab-bag of visual + editor
// controls; the Editor panel keeps Appearance purely visual (theme / custom
// theme). Taxonomy change recorded in `docs/decisions.md`
// (supersedes the 2026-05-08 5-panel lock).
//
// Each child control persists **disk-first** with no in-flight gating (the
// writes are fast, not Argon2-bound), matching their prior behaviour under
// Appearance. This panel is a thin composition shell — the persistence logic
// lives in the two child components.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  contentWidthKey,
  fontFamilyKey,
  lineSpacingKey,
  textSizeKey,
  typographyStyleFromKeys,
} from "../../editor/typography";
import { asViewMode } from "../../editor/view-mode";
import { TypographySettings } from "./TypographySettings";
import { LineNumbersSettings } from "./LineNumbersSettings";
import { VimModeSettings } from "./VimModeSettings";
import { ToolbarCustomizeSettings } from "./ToolbarCustomizeSettings";
import { DateTimeSettings } from "./DateTimeSettings";
import { DefaultViewModeSettings } from "./DefaultViewModeSettings";
import { FocusModeSettings } from "./FocusModeSettings";
import { SpellSettings } from "./SpellSettings";
import { PeriodicNotesSettings } from "./PeriodicNotesSettings";
import { ArchiveSettings } from "./ArchiveSettings";
import { ViewsSettings } from "./ViewsSettings";
import { ReminderHorizonSettings, ReminderSettings } from "./ReminderSettings";
import { PANEL_ROOT_STYLE } from "./panel-styles";
import { SettingsSection } from "./SettingsSection";
import { useSettingsCompact } from "./settingsCompact";
import { usePrefs } from "../../hooks/usePrefs";

// Two-column layout: the controls scroll on the left, a live preview sticks on
// the right. Only the Editor tab carries a preview — it is the one tab whose
// settings (type size, line spacing, font) have an effect you cannot picture
// without seeing it, and the editor itself is hidden behind the modal while you
// choose. No other Settings tab needs one.
const EDITOR_LAYOUT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "var(--space-6)",
  alignItems: "flex-start",
};
const CONTROLS_COL_STYLE: CSSProperties = {
  ...PANEL_ROOT_STYLE,
  flex: "1 1 auto",
  minWidth: 0,
};
const PREVIEW_COL_STYLE: CSSProperties = {
  flex: "0 0 264px",
  width: 264,
  position: "sticky",
  top: 0,
  alignSelf: "flex-start",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};
const PREVIEW_CAPTION_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};
// Mirrors the editor's own paper + rule so the specimen reads as a slice of the
// note surface rather than a settings widget.
const PREVIEW_FRAME_STYLE: CSSProperties = {
  background: "var(--paper-1, var(--bg-1))",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-4)",
  overflow: "hidden",
};
// All three read the SAME `--editor-*` custom properties the real editor reads
// (set on the wrapper by `typographyStyleFromKeys`), so the specimen cannot show
// something a note will not.
const SAMPLE_HEADING_STYLE: CSSProperties = {
  margin: "0 0 var(--space-2)",
  color: "var(--fg-1)",
  fontFamily: "var(--editor-font-family)",
  fontSize: "calc(var(--editor-text-size) * 1.5)",
  lineHeight: "var(--editor-line-spacing)",
  fontWeight: "var(--weight-semibold)",
};
const SAMPLE_BODY_STYLE: CSSProperties = {
  margin: "0 0 var(--space-2)",
  color: "var(--fg-1)",
  fontFamily: "var(--editor-font-family)",
  fontSize: "var(--editor-text-size)",
  lineHeight: "var(--editor-line-spacing)",
};
// One "line" row: the line-numbers gutter (when on) + the block content. The
// gutter number pins to the block's first line (matching how an editor numbers a
// wrapped soft-line: one number at top, no number on the wrapped rows).
const LINE_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "var(--space-2)",
  alignItems: "flex-start",
};
const GUTTER_STYLE: CSSProperties = {
  flex: "0 0 auto",
  minWidth: "1.6em",
  textAlign: "end",
  color: "var(--fg-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "calc(var(--editor-text-size) * 0.85)",
  lineHeight: "var(--editor-line-spacing)",
  userSelect: "none",
  opacity: 0.7,
};
// The faint markdown markers shown in Live view (# before a heading, - before a
// bullet) and the • bullet glyph shown in Reading view.
const MARKER_STYLE: CSSProperties = { color: "var(--fg-3)", opacity: 0.65 };
const SOURCE_LINE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "calc(var(--editor-text-size) * 0.92)",
  lineHeight: "var(--editor-line-spacing)",
  color: "var(--fg-1)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};
// Spell-check demo, shown only when spell-check is on: the editor's own wavy-red
// underline (`.cm-spell-error` in `editor/src/theme.ts`) on a misspelled word.
const SPELL_DEMO_STYLE: CSSProperties = {
  marginTop: "var(--space-3)",
  paddingTop: "var(--space-2)",
  borderTop: "1px solid var(--line-1)",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
};
const SPELL_SQUIGGLE_STYLE: CSSProperties = {
  textDecoration: "underline wavy var(--danger, #8a2a23)",
  color: "var(--fg-1)",
  fontFamily: "var(--editor-font-family)",
  fontSize: "var(--text-sm)",
};

// Live typography specimen for the Editor tab. Reads prefs via its own
// `usePrefs` — the typography setters (and line-numbers / view-mode / spell
// toggles) bump the prefs nonce, which every `usePrefs` instance subscribes to
// and re-reads on, so the specimen updates as the user changes a control (same
// path the live editor updates through). It reflects the four typography
// presets PLUS line numbers, the default view mode (Live markers / Reading /
// Source), and spell-check.
function EditorSettingsPreview() {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const typo = typographyStyleFromKeys({
    textSize: textSizeKey(prefs),
    lineSpacing: lineSpacingKey(prefs),
    contentWidth: contentWidthKey(prefs),
    fontFamily: fontFamilyKey(prefs),
  });
  const lineNumbers = prefs.editor_line_numbers === true;
  const mode = asViewMode(prefs.editor_default_view_mode);
  const spell = prefs.spell_enabled === true;

  const heading = t("settings.editor.preview.heading");
  const body = t("settings.typography.previewBody");
  const bullets = [
    t("settings.editor.preview.bullet1"),
    t("settings.editor.preview.bullet2"),
  ];
  const modeLabelKey =
    mode === "reading"
      ? "settings.viewMode.optionReading"
      : mode === "source"
        ? "settings.viewMode.optionSource"
        : "settings.viewMode.optionLive";

  // Wrap a rendered block with the gutter when line numbers are on.
  const numbered = (n: number, content: ReactNode): ReactNode =>
    lineNumbers ? (
      <div style={LINE_ROW_STYLE}>
        <span style={GUTTER_STYLE}>{n}</span>
        <div style={{ flex: 1, minWidth: 0 }}>{content}</div>
      </div>
    ) : (
      content
    );

  let bodyEl: ReactNode;
  if (mode === "source") {
    // Raw markdown, mono — what Source view shows.
    const src = [`# ${heading}`, "", body, "", `- ${bullets[0]}`, `- ${bullets[1]}`];
    bodyEl = (
      <div>
        {src.map((ln, i) => (
          <div key={i} style={LINE_ROW_STYLE}>
            {lineNumbers && <span style={GUTTER_STYLE}>{i + 1}</span>}
            <span style={{ ...SOURCE_LINE_STYLE, flex: 1 }}>{ln || " "}</span>
          </div>
        ))}
      </div>
    );
  } else {
    // Rendered. Live view surfaces the markdown markers faintly; Reading hides
    // them and shows a • bullet glyph instead.
    const live = mode === "live";
    const bulletMark = live ? "- " : "• ";
    bodyEl = (
      <>
        {numbered(
          1,
          <h4 style={SAMPLE_HEADING_STYLE}>
            {live && <span style={MARKER_STYLE}># </span>}
            {heading}
          </h4>,
        )}
        {numbered(2, <p style={SAMPLE_BODY_STYLE}>{body}</p>)}
        {numbered(
          3,
          <p style={SAMPLE_BODY_STYLE}>
            <span style={MARKER_STYLE}>{bulletMark}</span>
            {bullets[0]}
          </p>,
        )}
        {numbered(
          4,
          <p style={{ ...SAMPLE_BODY_STYLE, marginBottom: 0 }}>
            <span style={MARKER_STYLE}>{bulletMark}</span>
            {bullets[1]}
          </p>,
        )}
      </>
    );
  }

  return (
    <aside style={PREVIEW_COL_STYLE} data-testid="settings.editor-preview">
      <span style={PREVIEW_CAPTION_STYLE}>
        {t("settings.typography.previewLabel")} · {t(modeLabelKey)}
      </span>
      <div style={PREVIEW_FRAME_STYLE}>
        <div style={{ ...typo }}>{bodyEl}</div>
        {spell && (
          <div style={SPELL_DEMO_STYLE} data-testid="settings.editor-preview-spell">
            <span style={PREVIEW_CAPTION_STYLE}>
              {t("settings.editor.preview.spellCaption")}
            </span>
            <span style={SPELL_SQUIGGLE_STYLE}>
              {t("settings.editor.preview.spellSample")}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}

export interface EditorPanelProps {
  /**
   * Toast surface, threaded from `SettingsModal.onShowToast` exactly as
   * `PrivacyPanel` and `AiPanel` thread it. Without it `usePrefs`'s optimistic
   * writes fail silently: `writeOptimisticPref` calls `onError?.(…)` into
   * nothing, and when its converging re-read also fails it deliberately keeps
   * the optimistic value, so a horizon that was never persisted goes on being
   * displayed (myne#508). Optional for the dev and non-Tauri mounts that have
   * no toast surface.
   */
  onShowToast?: (message: string) => void;
}

export function EditorPanel({ onShowToast }: EditorPanelProps = {}) {
  const { t } = useTranslation();
  // Task reminders (MYND-618) read their pref here and echo the toggle locally:
  // `usePrefs` reads once on mount, so the panel — not the hook — is what keeps
  // the switch in step with the write the block performs itself.
  const { prefs, setReminderHorizon } = usePrefs(onShowToast);
  // On a narrow dialog the 264px preview column is dropped (#391): it is
  // decoration for the settings, not a setting, and the space it frees lets the
  // controls column keep its rows side-by-side instead of overlapping.
  const compact = useSettingsCompact();
  const [remindersEnabled, setRemindersEnabledEcho] = useState<boolean | null>(null);
  useEffect(() => {
    setRemindersEnabledEcho(null);
  }, [prefs.reminders_enabled]);
  // Resolved once: two adjacent rows read it, and the horizon row's visibility
  // is the switch's own state rather than a second copy of it.
  const remindersOn = remindersEnabled ?? prefs.reminders_enabled;

  return (
    <div style={EDITOR_LAYOUT_STYLE}>
      <div style={CONTROLS_COL_STYLE}>
      {/* MYND-624: grouped rather than run together. The order within each group
          is unchanged; only the seams are new. */}
      <SettingsSection
        title={t("settings.editor.sections.text")}
        testId="settings.section.editor-text"
      >
        {/* Editor-typography (editor-typography) — text size / line spacing /
            content width / font family presets. */}
        <TypographySettings />
        {/* Line-number gutter toggle (editor-line-numbers, MYND-314) — off by
            default. */}
        <LineNumbersSettings />
      </SettingsSection>

      <SettingsSection
        title={t("settings.editor.sections.editing")}
        testId="settings.section.editor-editing"
      >
        {/* Vim keyboard mode (vim-keyboard-mode, MYND-313) — optional modal
            editing; off by default. The engine is only downloaded when this is
            turned on.

            Behind Developer mode (#181), the same setting-level gate the CLI
            block in PrivacyPanel carries: a power-user editing affordance kept
            out of the default Settings surface. It stays in Editor rather than
            moving to a Developer panel so "where's my vim setting?" still lands
            where the topic lives. Hiding is not disabling — an already-enabled
            keymap keeps running when the mode goes back off. */}
        {prefs.developer_mode && <VimModeSettings />}
        {/* Default view mode (reading-source-modes, MYND-299) — Live/Reading/
            Source a note opens in; per-tab override via ⇧⌘E. */}
        <DefaultViewModeSettings />
        {/* Date, time and zone DISPLAY (myne#279) — the single home for how a
            date is printed, replacing four surfaces that each decided for
            themselves. Display only: note bytes stay zone-free wall-clock. */}
        <DateTimeSettings />
        {/* Focus-mode behaviours (focus-mode, MYND-348) — typewriter scroll +
            dim inactive lines, honored when focus mode (⇧⌘F) is active. */}
        <FocusModeSettings />
        {/* Floating-toolbar customization (MYND-336) — reorder + show/hide the
            selection toolbar's buttons over the frozen command vocabulary. */}
        <ToolbarCustomizeSettings />
      </SettingsSection>

      <SettingsSection
        title={t("settings.editor.sections.writing")}
        testId="settings.section.editor-writing"
      >
        {/* Spell-check configuration (MYND-267) — toggle + language picker. */}
        <SpellSettings />
        {/* Task reminders (MYND-618) — note-authoring behaviour, which is why it
            belongs in this group rather than under Appearance. Device-local:
            whether THIS machine is interrupted is a property of the machine. */}
        <ReminderSettings enabled={remindersOn} onEnabledChange={setRemindersEnabledEcho} />
        {/* Its own row rather than a control nested under the switch (myne#508):
            the canon's shape for a setting, and the only one that gives the
            picker a visible label. It holds no state of its own:
            `setReminderHorizon` is `usePrefs`'s optimistic setter, so
            `prefs.reminder_horizon_days` is already current by the time this
            re-renders. */}
        <ReminderHorizonSettings
          enabled={remindersOn}
          horizonDays={prefs.reminder_horizon_days}
          onChange={(days) => void setReminderHorizon(days)}
        />
      </SettingsSection>

      {/* Periodic notes (MYND-191 daily, myne#177 weekly + monthly): folder /
          title format / template, one section per period. Rendered at PANEL
          level rather than inside Writing above: `SettingsSection` draws a rule
          to the panel edge, so nesting three of them made the Reminder rows
          that followed sit under the Monthly divider and read as monthly
          settings. */}
      <PeriodicNotesSettings />

      <SettingsSection
        title={t("settings.editor.sections.features")}
        testId="settings.section.editor-features"
      >
        {/* Note-archive feature toggle — on by default; turning it off restores
            every archived note and hides the archive controls. */}
        <ArchiveSettings />
        {/* Views feature toggle (device-local) — off by default; counted on when
            the vault already has saved views. Hides the sidebar "Views" entry. */}
        <ViewsSettings />
      </SettingsSection>
      </div>
      {!compact && <EditorSettingsPreview />}
    </div>
  );
}
