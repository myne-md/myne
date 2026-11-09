// Settings → Editor panel: note-authoring behaviour preferences that are not
// visual - spell-check (toggle + language picker, MYND-267) and daily-notes
// configuration (folder / date-format / template, MYND-191). Both moved here
// from the Appearance panel, which had become a grab-bag of visual + editor
// controls; the Editor panel keeps Appearance purely visual (theme / custom
// theme). Taxonomy change recorded in `design-notes.md`
// (supersedes the 2026-05-08 5-panel lock).
//
// **This panel has an in-panel topic strip since myne-md/myne#885**, and it is
// the panel the requester named as the model. Its five `SettingsSection`s plus
// the periodic-notes block become the six topics in `settingsTopics.ts`, whose
// roster carries the boundary argument; each topic's body is wrapped in a
// `SettingsTopicPanel` here, and only the active one is mounted. The preview
// column follows the ACTIVE TOPIC (`PREVIEW_BANDS`), which is the one place the
// work departs from the requester's literal "as you scroll" and is argued at
// that map.
//
// Each child control persists **disk-first** with no in-flight gating (the
// writes are fast, not Argon2-bound), matching their prior behaviour under
// Appearance. This panel is a thin composition shell - the persistence logic
// lives in the two child components.

import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
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
import { has } from "../../platform/capabilities";
import { VimModeSettings } from "./VimModeSettings";
import { PlainFileSettings } from "./PlainFileSettings";
import { ToolbarCustomizeSettings } from "./ToolbarCustomizeSettings";
import { DateTimeSettings } from "./DateTimeSettings";
import { DefaultViewModeSettings } from "./DefaultViewModeSettings";
import { FocusModeSettings } from "./FocusModeSettings";
import { SpellSettings } from "./SpellSettings";
import { PeriodicNotesSettings } from "./PeriodicNotesSettings";
import { CalendarSettings } from "./CalendarSettings";
import { ArchiveSettings } from "./ArchiveSettings";
import { ViewsSettings } from "./ViewsSettings";
import { ReminderHorizonSettings, ReminderSettings } from "./ReminderSettings";
import { PANEL_ROOT_STYLE } from "./panel-styles";
import { SettingsSection } from "./SettingsSection";
import { SettingsTopicPanel, useActiveSettingsTopic } from "./SettingsTabs";
import {
  EDITOR_PANEL_TOPICS,
  type EditorTopicId,
} from "./settingsTopics";
import { SettingRow } from "./SettingRow";
import { Select } from "../primitives/Select";
import { Switch } from "../primitives/Switch";
import { useSettingsCompact } from "./settingsCompact";
import { usePrefs } from "../../hooks/usePrefs";
import { useWorkspace } from "../../notes/workspaceContext";
import { useDateTimeDisplay } from "../../lib/useDateTimeDisplay";
import { formatStoredValue } from "../../lib/datetimeFormat";
import { taskChipIcon } from "@myne/editor/host/notes/taskChipIcon";
import { taskChipStyle } from "@myne/editor/host/notes/taskChipToken";
import {
  resolveToolbarHidden,
  resolveToolbarOrder,
  toolbarItemLabelKey,
} from "../../notes/toolbarItems";
import {
  TASK_CHIP_COLORS,
  TASK_CHIP_INK,
  type TaskChipColor,
} from "../../notes/taskDisplay";

// Two-column layout: the controls scroll on the left, a live preview sticks on
// the right. Only the Editor tab carries a preview - it is the one tab whose
// settings (type size, line spacing, font, the date format, the toolbar, the
// task chips) have an effect you cannot picture without seeing it, and the
// editor itself is hidden behind the modal while you choose. No other Settings
// tab needs one. The preview column is a SIBLING of the controls column, inside
// the shell's scroll container, which is what keeps its `sticky` positioning
// working while the active topic's controls scroll past it.
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
// A band under the note body: its own hairline, a small caption, and the thing
// it demonstrates. The note body is not a band (it is the specimen), so every
// band here is something the ACTIVE TOPIC's settings decide.
// A band carries no separator of its own: the frame draws one BETWEEN bands
// (`BAND_SEPARATOR_STYLE`), so a topic whose specimen is a single band does not
// open with a hairline above nothing (myne-md/myne#885 visual pass).
// A hairline inside the specimen frame, not a settings-section seam, so it is a
// border (the section seam is `SettingsSection`'s alone, and
// `settingsSectionTreatment.test.tsx` holds it there).
const BAND_SEPARATOR_STYLE: CSSProperties = {
  borderTop: "1px solid var(--line-1)",
  margin: "var(--space-3) 0 var(--space-2)",
};
const BAND_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};
// The toolbar band: the buttons the customisation resolves to, in their resolved
// order, labelled with the same i18n keys the customisation list itself uses.
const TOOLBAR_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-1)",
};
const TOOLBAR_BUTTON_STYLE: CSSProperties = {
  padding: "2px 6px",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  background: "var(--paper-2)",
  color: "var(--fg-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  whiteSpace: "nowrap",
};
// The task band: one priority chip, drawn with the SHARED chip token
// (`taskChipStyle`) so the specimen cannot drift from a chip inside a note.
const TASK_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
};
// The chips sit on their own line under the task text, indented to the text's
// start, which is how a task with several chips wraps in a narrow column anyway.
const TASK_CHIPS_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-1)",
  paddingInlineStart: "calc(14px + var(--space-2))",
};
const TASK_BOX_STYLE: CSSProperties = {
  flex: "0 0 auto",
  width: 14,
  height: 14,
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1)",
};
const TASK_BOX_DONE_STYLE: CSSProperties = {
  ...TASK_BOX_STYLE,
  background: "var(--accent)",
  borderColor: "var(--accent)",
};
const TASK_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};
const TASK_TEXT_DONE_STYLE: CSSProperties = {
  ...TASK_TEXT_STYLE,
  color: "var(--fg-3)",
  textDecorationLine: "line-through",
};

/** The date and wall-clock the date/time band prints. A FIXED sample, so the
 *  band answers "what does my format look like" rather than "what day is it",
 *  which is also what makes it assertable without a clock. */
const PREVIEW_SAMPLE_VALUE = "2026-08-01T14:30";

/** One band of the specimen. See {@link PREVIEW_BANDS}. */
type PreviewBand = "note" | "dateTime" | "toolbar" | "taskChip";

/**
 * Which bands each Editor topic's specimen shows.
 *
 * **This map is the whole of the PRD's Open Question 4.** With a strip, "the
 * section you scroll" becomes "the topic you are on", and the preview follows
 * the TOPIC. The reason is not that the scroll version is impossible: it is that
 * it would need an `IntersectionObserver` over a scroll container that already
 * resets on every topic change (`SettingsModal`'s own scroll reset), it would
 * move the specimen under the user while they read the controls they are
 * comparing it against, and with topics the scroll is short enough that "which
 * section is in view" is often ambiguous. The topic is discrete, it is what the
 * user just clicked, and the strip makes it the panel's primary navigation, so
 * the preview following it is the consistent answer. Recorded here because the
 * PRD asks for the departure from the requester's literal words to be written
 * down rather than discovered.
 *
 * `periodic` and `features` map to an EMPTY list on purpose, and that is the
 * honest boundary task 7 asks for rather than a gap: periodic-note settings
 * decide where a new note is FILED and how it is TITLED, and the two feature
 * switches decide what the sidebar offers. Neither changes what a note looks
 * like, so a specimen for either would be an imitation of a preview. For those
 * topics the preview column is not drawn at all (myne-md/myne#885 visual pass):
 * a framed box saying there is nothing to show was a panel spent on an absence,
 * and the controls get the width instead.
 */
const PREVIEW_BANDS: Record<EditorTopicId, readonly PreviewBand[]> = {
  text: ["note"],
  editing: ["note", "dateTime", "toolbar"],
  // Writing is EMPTY (owner, 2026-11-08): `decisions/clients/0803` reverses #885
  // item 2 for this topic. The column is the controls' width, as for `periodic`.
  writing: [],
  tasks: ["taskChip"],
  periodic: [],
  calendar: [],
  features: [],
};

/** A task chip's glyph, built through the shared icon factory so the specimen
 *  draws the same shape an inline chip does (a priority's level is carried by
 *  the SHAPE, which is what survives a monochrome or colour-blind reading).
 *  Built in an effect for `TaskRow`'s `ChipGlyph` reason: the factory returns a
 *  DOM node, and this tree never reaches for an innerHTML escape hatch. */
function ChipGlyph({ kind, value }: { kind: "due" | "priority"; value: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el !== null) el.replaceChildren(taskChipIcon(kind, value));
  }, [kind, value]);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      style={{ display: "inline-flex", width: "1em", height: "1em", flex: "0 0 auto" }}
    />
  );
}

/** Whether the specimen is ONE band with no note above it, in which case the
 *  preview's own caption (the topic's name) already says what the band is, and
 *  a band caption under it would print the same word twice. */
const LoneBandContext = createContext(false);

/** A band's small caption, in the preview caption's own treatment. */
function BandCaption({ children }: { children: ReactNode }) {
  if (useContext(LoneBandContext)) return null;
  return <span style={PREVIEW_CAPTION_STYLE}>{children}</span>;
}

// Live specimen for the Editor tab, one band set per ACTIVE TOPIC.
//
// It reads prefs via its own `usePrefs` - the typography setters (and
// line-numbers / view-mode / spell / date-time / toolbar toggles) bump the prefs
// nonce, which every `usePrefs` instance subscribes to and re-reads on, so the
// specimen updates as the user changes a control (the same path the live editor
// updates through). Two inputs deliberately do NOT come from prefs: the date and
// time display comes from the SHARED store a note's own dates read
// (`useDateTimeDisplay`, the same call `TaskRow` makes), and the task-chip
// display comes from the workspace container (`useWorkspace`), because that is
// where those two settings live. Reading them from anywhere else would let the
// specimen print something no note would.
//
// Every band reads a token or a shared helper rather than a literal: the note
// body reads the `--editor-*` custom properties the real editor reads, the date
// band goes through the same formatter a note's dates go through, the toolbar
// band through the same resolver the editor's toolbar uses, and the chip through
// the shared chip token.
function EditorSettingsPreview() {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const ws = useWorkspace();
  const display = useDateTimeDisplay();
  const topic = useActiveSettingsTopic(
    "editor",
    EDITOR_PANEL_TOPICS,
  ) as EditorTopicId;
  const bands = PREVIEW_BANDS[topic] ?? [];

  const typo = typographyStyleFromKeys({
    textSize: textSizeKey(prefs),
    lineSpacing: lineSpacingKey(prefs),
    contentWidth: contentWidthKey(prefs),
    fontFamily: fontFamilyKey(prefs),
  });
  const lineNumbers = prefs.editor_line_numbers === true;
  const mode = asViewMode(prefs.editor_default_view_mode);
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
  const topicLabel = t(
    EDITOR_PANEL_TOPICS.find((meta) => meta.id === topic)?.labelKey ?? "",
  );

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

  let noteBand: ReactNode;
  if (mode === "source") {
    // Raw markdown, mono - what Source view shows.
    const src = [`# ${heading}`, "", body, "", `- ${bullets[0]}`, `- ${bullets[1]}`];
    noteBand = (
      <div>
        {src.map((ln, i) => (
          <div key={i} style={LINE_ROW_STYLE}>
            {lineNumbers && <span style={GUTTER_STYLE}>{i + 1}</span>}
            <span style={{ ...SOURCE_LINE_STYLE, flex: 1 }}>{ln || " "}</span>
          </div>
        ))}
      </div>
    );
  } else {
    // Rendered. Live view surfaces the markdown markers faintly; Reading hides
    // them and shows a • bullet glyph instead.
    const live = mode === "live";
    const bulletMark = live ? "- " : "• ";
    noteBand = (
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

  const dateTimeBand = (
    <div style={BAND_STYLE} data-testid="settings.editor-preview-datetime">
      <BandCaption>{t("settings.editor.preview.dateTime")}</BandCaption>
      <p style={{ ...SAMPLE_BODY_STYLE, marginBottom: 0 }}>
        {formatStoredValue(PREVIEW_SAMPLE_VALUE, display)}
      </p>
    </div>
  );

  const toolbarOrder = resolveToolbarOrder(
    prefs.editor_toolbar_order,
    resolveToolbarHidden(prefs.editor_toolbar_hidden),
  );
  const toolbarBand = (
    <div style={BAND_STYLE} data-testid="settings.editor-preview-toolbar">
      <BandCaption>{t("settings.editor.preview.toolbar")}</BandCaption>
      <div style={TOOLBAR_ROW_STYLE}>
        {toolbarOrder.map((id) => (
          <span
            key={id}
            style={TOOLBAR_BUTTON_STYLE}
            data-testid={`settings.editor-preview-toolbar-${id}`}
            data-item-id={id}
          >
            {t(toolbarItemLabelKey(id) ?? id)}
          </span>
        ))}
      </div>
    </div>
  );

  // The colour is the SAME closed-enum-to-token mapping `Editor.tsx` publishes
  // as `--task-chip-ink` for a note's own chips, so the specimen and a chip in a
  // note cannot disagree.
  //
  // Two task lines rather than one bare chip (myne-md/myne#885 visual pass): a
  // chip on its own did not say what it decorates. An open task carries a due
  // chip (its date through the same formatter a note's dates use, so the date
  // format setting shows here too) and the priority chip both settings act on;
  // a done task shows the checked, struck-through state beside it.
  const chipColor = ws.taskDisplay.chipColor;
  const chipStyle: CSSProperties = { ...taskChipStyle(), color: TASK_CHIP_INK[chipColor] };
  const dueText = formatStoredValue(PREVIEW_SAMPLE_VALUE.slice(0, 10), display);
  const taskBand = (
    <div style={BAND_STYLE} data-testid="settings.editor-preview-task">
      <BandCaption>{t("settings.editor.preview.task")}</BandCaption>
      <div style={TASK_ROW_STYLE}>
        <span style={TASK_BOX_STYLE} aria-hidden="true" />
        <span style={TASK_TEXT_STYLE}>{t("settings.editor.preview.taskSampleOpen")}</span>
      </div>
      <div style={TASK_CHIPS_STYLE}>
        <span style={chipStyle} data-testid="settings.editor-preview-task-due">
          <ChipGlyph kind="due" value={PREVIEW_SAMPLE_VALUE.slice(0, 10)} />
          <span>{dueText}</span>
        </span>
        <span
          style={chipStyle}
          data-testid="settings.editor-preview-task-chip"
          data-chip-color={chipColor}
          data-icon-only={ws.taskDisplay.iconOnly ? "true" : "false"}
        >
          <ChipGlyph kind="priority" value="high" />
          {/* The editor hides the label through a root attribute rather than
              dropping it, because a live editor must not be reconfigured to
              flip a setting. A specimen has no widget to reconfigure, so it
              renders what the rule would hide: icon-only means the word is
              gone. */}
          {!ws.taskDisplay.iconOnly && (
            <span data-testid="settings.editor-preview-task-label">
              {t("tasks.priority.high")}
            </span>
          )}
        </span>
      </div>
      <div style={TASK_ROW_STYLE}>
        <span style={TASK_BOX_DONE_STYLE} aria-hidden="true" />
        <span style={TASK_TEXT_DONE_STYLE}>{t("settings.editor.preview.taskSampleDone")}</span>
      </div>
    </div>
  );

  return (
    <aside
      style={PREVIEW_COL_STYLE}
      data-testid="settings.editor-preview"
      data-topic={topic}
    >
      <span style={PREVIEW_CAPTION_STYLE}>
        {bands.includes("note")
          ? `${t("settings.typography.previewLabel")} · ${topicLabel} · ${t(modeLabelKey)}`
          : topicLabel}
      </span>
      <div style={PREVIEW_FRAME_STYLE}>
        <LoneBandContext.Provider value={bands.length === 1 && !bands.includes("note")}>
          {(
            [
              ["note", bands.includes("note") ? <div style={{ ...typo }}>{noteBand}</div> : null],
              ["dateTime", bands.includes("dateTime") ? dateTimeBand : null],
              ["taskChip", bands.includes("taskChip") ? taskBand : null],
              ["toolbar", bands.includes("toolbar") ? toolbarBand : null],
            ] as const
          )
            .filter(([, node]) => node !== null)
            .map(([key, node], i) => (
              <Fragment key={key}>
                {i > 0 && <div style={BAND_SEPARATOR_STYLE} aria-hidden="true" />}
                {node}
              </Fragment>
            ))}
        </LoneBandContext.Provider>
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
  /**
   * The pending settings-search target (MYND-536), passed straight through to
   * `PeriodicNotesSettings`. It needs it because that block renders ONE period
   * at a time, so a search hit on a period that is not selected would resolve to
   * no anchor at all and the shell's jump would degrade to a bare panel switch.
   * Read `PeriodicNotesSettings.tsx`'s header before changing this path.
   */
  focusAnchorId?: string;
}

const CHIP_SETTING_CONTROL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
};
const CHIP_SAMPLE_STYLE: CSSProperties = {
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-pill)",
  padding: "2px 8px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-medium)",
  whiteSpace: "nowrap",
};

/**
 * Settings -> Editor -> Tasks: the task chip's ink colour (myne-md/myne#656
 * item 4). Device-local and window-global, carried on the workspace container
 * (not a vault pref). The stored value is a closed enum that SELECTS a token,
 * so a tampered descriptor can never land a string in a style position.
 */
function TaskChipInkSetting(): ReactNode {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const value = ws.taskDisplay.chipColor;
  return (
    <SettingRow
      label={t("settings.editor.taskChipColor.label")}
      helper={t("settings.editor.taskChipColor.help")}
      testId="settings.editor.taskChipColor"
      anchorId="settings.editor.taskChipColor"
      control={(helperId) => (
        <div style={CHIP_SETTING_CONTROL_STYLE}>
          <span
            style={{ ...CHIP_SAMPLE_STYLE, color: TASK_CHIP_INK[value] }}
            aria-hidden="true"
          >
            {t("settings.editor.taskChipColor.sample")}
          </span>
          <Select
            options={TASK_CHIP_COLORS.map((c) => ({
              value: c,
              label: t(`settings.editor.taskChipColor.${c}`),
            }))}
            value={value}
            onChange={(v) => ws.setTaskDisplay({ ...ws.taskDisplay, chipColor: v as TaskChipColor })}
            aria-label={t("settings.editor.taskChipColor.label")}
            ariaDescribedBy={helperId}
            testId="settings.editor.taskChipColor.control"
          />
        </div>
      )}
    />
  );
}

/**
 * Settings -> Editor -> Tasks: icon-only priority chips (myne-md/myne#656 item
 * 5). Device-local; applied through a root attribute so a live editor does not
 * need reconfiguring.
 */
function TaskChipIconOnlySetting(): ReactNode {
  const { t } = useTranslation();
  const ws = useWorkspace();
  return (
    <SettingRow
      label={t("settings.editor.taskChipIconOnly.label")}
      helper={t("settings.editor.taskChipIconOnly.help")}
      testId="settings.editor.taskChipIconOnly"
      anchorId="settings.editor.taskChipIconOnly"
      control={
        <Switch
          checked={ws.taskDisplay.iconOnly}
          onChange={(next) => ws.setTaskDisplay({ ...ws.taskDisplay, iconOnly: next })}
          ariaLabel={t("settings.editor.taskChipIconOnly.label")}
          testId="settings.editor.taskChipIconOnly.control"
        />
      }
    />
  );
}

export function EditorPanel({ onShowToast, focusAnchorId }: EditorPanelProps = {}) {
  const { t } = useTranslation();
  // Task reminders (MYND-618) read their pref here and echo the toggle locally:
  // `usePrefs` reads once on mount, so the panel - not the hook - is what keeps
  // the switch in step with the write the block performs itself.
  const { prefs, setReminderHorizon } = usePrefs(onShowToast);
  // On a narrow dialog the 264px preview column is dropped (#391): it is
  // decoration for the settings, not a setting, and the space it frees lets the
  // controls column keep its rows side-by-side instead of overlapping.
  const compact = useSettingsCompact();
  // The preview column is drawn only for a topic it can depict (see
  // `PREVIEW_BANDS`), so the panel reads the active topic too.
  const activeTopic = useActiveSettingsTopic("editor", EDITOR_PANEL_TOPICS) as EditorTopicId;
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
          is unchanged; only the seams are new. **Each topic's body is wrapped at
          the SAME indentation on purpose** (the convention the AI panel set): a
          wrapper that re-indented 400 lines would turn "which rows landed in
          which topic" into a whitespace diff nobody can read, and that is the
          one thing a reviewer has to check here. The topic's own label is the
          section title's key, so the tab and the heading name one concern. */}
      <SettingsTopicPanel panelId="editor" topicId="text">
      <SettingsSection
        title={t("settings.editor.sections.text")}
        testId="settings.section.editor-text"
      >
        {/* Editor-typography (editor-typography) - text size / line spacing /
            content width / font family presets. */}
        <TypographySettings />
        {/* Line-number gutter toggle (editor-line-numbers, MYND-314) - off by
            default. */}
        <LineNumbersSettings />
      </SettingsSection>
      </SettingsTopicPanel>

      <SettingsTopicPanel panelId="editor" topicId="editing">
      <SettingsSection
        title={t("settings.editor.sections.editing")}
        testId="settings.section.editor-editing"
      >
        {/* Vim keyboard mode (vim-keyboard-mode, MYND-313) - optional modal
            editing; off by default. The engine is only downloaded when this is
            turned on.

            Behind Developer mode (#181), the same setting-level gate the CLI
            block in PrivacyPanel carries: a power-user editing affordance kept
            out of the default Settings surface. It stays in Editor rather than
            moving to a Developer panel so "where's my vim setting?" still lands
            where the topic lives. Hiding is not disabling - an already-enabled
            keymap keeps running when the mode goes back off. */}
        {prefs.developer_mode && <VimModeSettings />}
        {/* Plain-file editor (myne-md/myne#788). On by default now, so the
            switch lives in the normal Editor settings rather than behind
            Developer mode (amended 2026-10-01): the control that turns the
            surface OFF has to be findable. Not a vault pref: the switch is
            device-local because the surface works with the vault locked and
            with no vault at all. */}
        {has("plainFile") && <PlainFileSettings />}
        {/* Default view mode (reading-source-modes, MYND-299) - Live/Reading/
            Source a note opens in; per-tab override via ⇧⌘E. */}
        <DefaultViewModeSettings />
        {/* Date, time and zone DISPLAY (myne#279) - the single home for how a
            date is printed, replacing four surfaces that each decided for
            themselves. Display only: note bytes stay zone-free wall-clock. */}
        <DateTimeSettings />
        {/* Focus-mode behaviours (focus-mode, MYND-348) - typewriter scroll +
            dim inactive lines, honored when focus mode (⇧⌘F) is active. */}
        <FocusModeSettings />
        {/* Floating-toolbar customization (MYND-336) - reorder + show/hide the
            selection toolbar's buttons over the frozen command vocabulary. */}
        <ToolbarCustomizeSettings />
      </SettingsSection>
      </SettingsTopicPanel>

      <SettingsTopicPanel panelId="editor" topicId="writing">
      <SettingsSection
        title={t("settings.editor.sections.writing")}
        testId="settings.section.editor-writing"
      >
        {/* Spell-check configuration (MYND-267) - toggle + language picker. */}
        <SpellSettings />
        {/* Task reminders (MYND-618) - note-authoring behaviour, which is why it
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
      </SettingsTopicPanel>

      <SettingsTopicPanel panelId="editor" topicId="tasks">
      <SettingsSection
        title={t("settings.editor.sections.tasks")}
        testId="settings.section.editor-tasks"
      >
        {/* Task chip ink colour (myne-md/myne#656 item 4) - device-local. */}
        <TaskChipInkSetting />
        {/* Icon-only priority chips (myne-md/myne#656 item 5) - device-local. */}
        <TaskChipIconOnlySetting />
      </SettingsSection>
      </SettingsTopicPanel>

      {/* Periodic notes (MYND-191 daily, myne#177 weekly + monthly): folder /
          title format / template, ONE period at a time behind a switcher.
          Rendered at PANEL level rather than inside Writing above: `SettingsSection`
          draws a rule to the panel edge, so nesting it inside another section
          made the Reminder rows that followed sit under its divider and read as
          its settings. Its own topic since myne-md/myne#885: the block is one
          concern ("how are my daily, weekly and monthly notes filed and
          titled") and it is reachable from exactly one topic. `focusAnchorId` is
          the settings-search target, which the switcher needs in order to open
          the right period before the shell looks for the anchor. */}
      <SettingsTopicPanel panelId="editor" topicId="periodic">
      <PeriodicNotesSettings focusAnchorId={focusAnchorId} />
      </SettingsTopicPanel>

      {/* Calendar (myne-md/myne#1037): the all-day reminder anchor and the
          per-calendar colour map, both riding ONE prefs map
          (`calendar_settings`). Its own topic for the reason the periodic block
          has one: it is one concern, reachable from exactly one place. The
          calendar's SURFACE is a pane and a phone screen, not a settings row —
          this is the configuration only. */}
      <SettingsTopicPanel panelId="editor" topicId="calendar">
      <CalendarSettings />
      </SettingsTopicPanel>

      <SettingsTopicPanel panelId="editor" topicId="features">
      <SettingsSection
        title={t("settings.editor.sections.features")}
        testId="settings.section.editor-features"
      >
        {/* Note-archive feature toggle - on by default; turning it off restores
            every archived note and hides the archive controls. */}
        <ArchiveSettings />
        {/* Views feature toggle (device-local) - off by default; counted on when
            the vault already has saved views. Hides the sidebar "Views" entry. */}
        <ViewsSettings />
      </SettingsSection>
      </SettingsTopicPanel>
      </div>
      {!compact && (PREVIEW_BANDS[activeTopic] ?? []).length > 0 && <EditorSettingsPreview />}
    </div>
  );
}
