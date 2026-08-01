// Slash command registry.
//
// `/wiki` (MYND-38) opens the note picker (it replaces the trigger with `[[`,
// which the WikilinkPickerView detects and opens on). `/table` (MYND-162)
// inserts an empty 2×2 grid and focuses the first cell.

import type { EditorView } from "@codemirror/view";
import { pickAndInsert } from "../attachments/picker";
import { startVoiceRecording } from "../attachments/voiceRecord";
import { getHost } from "../host";
import { requestTableCellFocus } from "../decorations/table";
import { emptyTableGrid, serializeTable } from "../decorations/table-model";
import {
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  formatLocalWeekday,
} from "@myne/editor/host/notes/localDateTime";
import i18n from "@myne/editor/i18n";
import { openTaskQueryBuilder } from "../task-query-builder";
import { openTaskFieldAdd } from "../task-field-menu";
import type { TaskFieldKind } from "../task-field-editor";
import type { Rect } from "../positioning";
import { isTaskLine } from "@myne/dialect/taskFieldWriter";
import type { SlashIconName } from "./icons";

export type SlashCommand = {
  id: string;
  label: string;
  /** Text-glyph icon (H1–H6, quote, …). Used when `svgIcon` is absent. */
  icon: string;
  /** Preferred Lucide SVG icon (clearer than a glyph for date/day/time/now,
   *  table, to-do, attach, voice, wiki-link). Rendered by the menu in place of
   *  {@link icon} when set. */
  svgIcon?: SlashIconName;
  /** Optional keyboard hint to render in the right column. */
  kbd?: string;
  apply: (view: EditorView, triggerFrom: number, triggerTo: number) => void;
};

function replaceLinePrefix(
  view: EditorView,
  triggerFrom: number,
  triggerTo: number,
  prefix: string,
): void {
  const line = view.state.doc.lineAt(triggerFrom);
  // Replace the slash + filter span first, then prepend `prefix` to the line.
  const lineText = view.state.doc.sliceString(line.from, line.to);
  const cleaned = lineText.slice(0, triggerFrom - line.from) +
    lineText.slice(triggerTo - line.from);
  const next = prefix + cleaned;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: next },
    selection: { anchor: line.from + prefix.length },
    userEvent: "slash.apply",
  });
}

function insertAtTrigger(
  view: EditorView,
  triggerFrom: number,
  triggerTo: number,
  insert: string,
  caretOffsetFromInsertStart?: number,
): void {
  view.dispatch({
    changes: { from: triggerFrom, to: triggerTo, insert },
    selection: {
      anchor: triggerFrom + (caretOffsetFromInsertStart ?? insert.length),
    },
    userEvent: "slash.apply",
  });
}

/**
 * Insert an empty 2×2 GFM table at the slash trigger, blank-line-separated from
 * surrounding content so two `/table` inserts never merge into one table
 * (`@lezer/markdown` joins adjacent table-row lines). A leading blank is added
 * when the previous line is non-blank (e.g. another table's last row); a trailing
 * blank when the following content is non-blank. There is always ≥1 newline after
 * the table so a cursor line exists below it. The cursor lands in the first cell.
 */
function insertTable(view: EditorView, triggerFrom: number, triggerTo: number): void {
  const source = serializeTable(emptyTableGrid(2, 1));
  const doc = view.state.doc;
  const triggerLine = doc.lineAt(triggerFrom);

  const beforeOnLine = doc.sliceString(triggerLine.from, triggerFrom);
  const prevLine = triggerLine.number > 1 ? doc.line(triggerLine.number - 1) : null;
  const needLead =
    beforeOnLine.trim() === "" && prevLine !== null && prevLine.text.trim() !== "";
  const lead = needLead ? "\n" : "";

  const afterOnLine = doc.sliceString(triggerTo, triggerLine.to);
  const nextLine = triggerLine.number < doc.lines ? doc.line(triggerLine.number + 1) : null;
  const followingNonBlank =
    afterOnLine.trim() !== "" || (nextLine !== null && nextLine.text.trim() !== "");
  const trail = followingNonBlank ? "\n\n" : "\n";

  const tableFrom = triggerFrom + lead.length;
  requestTableCellFocus(view, tableFrom, 0, 0); // before dispatch → rebuilt widget consumes it
  view.dispatch({
    changes: { from: triggerFrom, to: triggerTo, insert: `${lead}${source}${trail}` },
    selection: { anchor: tableFrom + 2 }, // first header cell content (fallback caret)
    userEvent: "slash.apply",
  });
}

/**
 * `/due` `/repeat` `/priority`: open the task-field editor directly for one
 * kind, adding it to the caret's task line. The kind is known, so these skip the
 * `+` affordance's three-way menu.
 *
 * Reuses the one add-opener (`openTaskFieldAdd`) the menu uses, which routes
 * through the tracked begin/apply seam — no new writer, no free-text field. Like
 * `/task-query` / `/attach`, the trigger text is removed first so nothing is
 * left behind; unlike them, a non-task line is auto-converted to `- [ ] ` (the
 * `/todo` behaviour) because asking to add a due date implies a task, and a
 * disabled command on a plain line would be a dead end.
 */
function openTaskFieldFromSlash(
  view: EditorView,
  triggerFrom: number,
  triggerTo: number,
  kind: TaskFieldKind,
): void {
  // 1. Remove the `/due…` trigger.
  view.dispatch({
    changes: { from: triggerFrom, to: triggerTo, insert: "" },
    selection: { anchor: triggerFrom },
    userEvent: "slash.apply",
  });
  // 2. Ensure the caret's line is a task; auto-convert prose like `/todo`.
  const line = view.state.doc.lineAt(triggerFrom);
  if (!isTaskLine(line.text)) {
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: "- [ ] " },
      userEvent: "slash.apply",
    });
  }
  // 3. Anchor to the caret coordinate (no element to point at). Read AFTER the
  //    dispatches above, since they shift positions.
  const head = view.state.selection.main.head;
  const lineFrom = view.state.doc.lineAt(head).from;
  const coords = view.coordsAtPos(head);
  const rect: Rect =
    coords !== null
      ? { left: coords.left, top: coords.top, right: coords.right, bottom: coords.bottom }
      : ((): Rect => {
          const editor = view.contentDOM.getBoundingClientRect();
          return {
            left: editor.left + 16,
            top: editor.top + 16,
            right: editor.left + 32,
            bottom: editor.top + 32,
          };
        })();
  openTaskFieldAdd(view, lineFrom, kind, rect);
}

export function slashCommands(): readonly SlashCommand[] {
  return [
    {
      id: "h1",
      label: i18n.t("editor.slash.heading1"),
      icon: "H1",
      kbd: "⌘⇧H",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "# "),
    },
    {
      id: "h2",
      label: i18n.t("editor.slash.heading2"),
      icon: "H2",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "## "),
    },
    {
      id: "h3",
      label: i18n.t("editor.slash.heading3"),
      icon: "H3",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "### "),
    },
    {
      id: "h4",
      label: i18n.t("editor.slash.heading4"),
      icon: "H4",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "#### "),
    },
    {
      id: "h5",
      label: i18n.t("editor.slash.heading5"),
      icon: "H5",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "##### "),
    },
    {
      id: "h6",
      label: i18n.t("editor.slash.heading6"),
      icon: "H6",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "###### "),
    },
    {
      id: "quote",
      label: i18n.t("editor.slash.quote"),
      icon: "”",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "> "),
    },
    {
      // MYND-47: inserts a note callout header; the user types the title and can
      // change the type. (A type-picker sub-palette is a flagged refinement.)
      // First blockquote-family construct the editor EMITS — §5 callout row.
      id: "callout",
      label: i18n.t("editor.slash.callout"),
      icon: "!",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "> [!note] "),
    },
    {
      id: "divider",
      label: i18n.t("editor.slash.divider"),
      icon: "—",
      apply: (v, f, t) => insertAtTrigger(v, f, t, "---\n"),
    },
    {
      // `/date` `/day` `/time` `/now` (MYND-338): insert the current local
      // date/time as FROZEN plain text at the trigger (not a live token). Formats
      // reuse the shared `localDateTime` helpers — the same source of truth as the
      // `{{date}}` template render context (local time, no UTC, no config).
      id: "date",
      label: i18n.t("editor.slash.date"),
      icon: "D",
      svgIcon: "calendar",
      apply: (v, f, t) => insertAtTrigger(v, f, t, formatLocalDate(new Date())),
    },
    {
      id: "day",
      label: i18n.t("editor.slash.day"),
      icon: "W",
      svgIcon: "sun",
      apply: (v, f, t) => insertAtTrigger(v, f, t, formatLocalWeekday(new Date())),
    },
    {
      id: "time",
      label: i18n.t("editor.slash.time"),
      icon: "T",
      svgIcon: "clock",
      apply: (v, f, t) => insertAtTrigger(v, f, t, formatLocalTime(new Date())),
    },
    {
      id: "now",
      label: i18n.t("editor.slash.now"),
      icon: "N",
      svgIcon: "alarm-clock",
      apply: (v, f, t) => insertAtTrigger(v, f, t, formatLocalDateTime(new Date())),
    },
    {
      // `/table` (MYND-162): insert a canonical empty 2×2 GFM table (header +
      // delimiter + one body row) and land the cursor in the first cell, where
      // the editable grid takes over.
      id: "table",
      label: i18n.t("editor.slash.table"),
      icon: "▦",
      svgIcon: "table",
      apply: (v, f, t) => insertTable(v, f, t),
    },
    {
      id: "link",
      label: i18n.t("editor.slash.link"),
      icon: "↗",
      kbd: "⌘K",
      apply: (v, f, t) => insertAtTrigger(v, f, t, "[]()", 1),
    },
    {
      id: "bullet",
      label: i18n.t("editor.slash.bulletList"),
      icon: "•",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "- "),
    },
    {
      id: "numbered",
      label: i18n.t("editor.slash.numberedList"),
      icon: "1.",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "1. "),
    },
    {
      id: "todo",
      label: i18n.t("editor.slash.todoList"),
      icon: "☐",
      svgIcon: "check-square",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "- [ ] "),
    },
    {
      // `/due` `/repeat` `/priority`: add a task field to the caret line without
      // typing the `[key:: value]` syntax. Each opens the same picker the chip
      // opens (native date / recurrence builder / priority select). A non-task
      // line is auto-converted to `- [ ] ` first.
      id: "due",
      label: i18n.t("editor.slash.due"),
      icon: "D",
      svgIcon: "calendar",
      apply: (v, f, t) => openTaskFieldFromSlash(v, f, t, "due"),
    },
    {
      id: "repeat",
      label: i18n.t("editor.slash.repeat"),
      icon: "↻",
      svgIcon: "repeat",
      apply: (v, f, t) => openTaskFieldFromSlash(v, f, t, "repeat"),
    },
    {
      id: "priority",
      label: i18n.t("editor.slash.priority"),
      icon: "!",
      svgIcon: "flag",
      apply: (v, f, t) => openTaskFieldFromSlash(v, f, t, "priority"),
    },
    {
      // `/tasks` (MYND-617 task 10): opens the query BUILDER rather than
      // inserting a bare fence. The builder is what makes the English-only
      // grammar acceptable — keywords are read, never memorized — so the slash
      // command must lead to it, not to an empty block the user has to fill in
      // from documentation they have not read.
      id: "task-query",
      label: i18n.t("editor.slash.taskQuery"),
      icon: "\u2611",
      svgIcon: "check-square",
      apply: (v, f, t) => {
        // Remove the trigger first so the inserted block lands cleanly, exactly
        // as `/attach` does before its async picker.
        v.dispatch({ changes: { from: f, to: t, insert: "" }, userEvent: "slash.apply" });
        const at = f;
        openTaskQueryBuilder({
          onInsert: (block) => {
            v.dispatch({
              changes: { from: at, to: at, insert: block },
              selection: { anchor: at + block.length },
              userEvent: "slash.apply",
            });
            v.focus();
          },
          onCancel: () => v.focus(),
        });
      },
    },
    {
      // `/attach` (MYND-164): a single command (not type-split) — opens the
      // allowlist-filtered file picker, imports each chosen file, and inserts
      // form-C embed(s) at the trigger position. The trigger text (`/attach…`)
      // is removed first so the embed lands cleanly.
      id: "attach",
      label: i18n.t("editor.slash.attachFile"),
      icon: "▣",
      svgIcon: "paperclip",
      apply: (v, f, t) => {
        v.dispatch({
          changes: { from: f, to: t, insert: "" },
          selection: { anchor: f },
          userEvent: "slash.apply",
        });
        void pickAndInsert(v, f);
      },
    },
    {
      // `/record` (MYND-259): record a voice note inline. Removes the trigger,
      // then arms capture. The host's optional `voiceRecord` slot wins when set
      // (mobile's WebView `getUserMedia` recorder); otherwise the package-default
      // desktop `cpal` recorder runs — the floating recording bar handles Stop
      // (insert the form-C embed) / Cancel (discard). Routing through the host
      // keeps `/record` from hitting the unregistered `voice_record_*` command on
      // a platform (mobile) that never wired the native recorder.
      id: "record",
      label: i18n.t("editor.slash.voiceNote"),
      icon: "◉",
      svgIcon: "mic",
      apply: (v, f, t) => {
        v.dispatch({
          changes: { from: f, to: t, insert: "" },
          selection: { anchor: f },
          userEvent: "slash.apply",
        });
        const host = getHost();
        if (host.voiceRecord) host.voiceRecord(v);
        else void startVoiceRecording(v);
      },
    },
    {
      // `/wiki` (MYND-38): replace the trigger with `[[`, which the picker
      // opens on (same path as typing `[[`). No closeBrackets auto-close on a
      // programmatic dispatch, so the in-progress filter stays chip-free.
      id: "wiki",
      label: i18n.t("editor.slash.wikiLink"),
      icon: "[[",
      svgIcon: "link-2",
      apply: (v, f, t) => {
        v.dispatch({
          changes: { from: f, to: t, insert: "[[" },
          selection: { anchor: f + 2 },
          userEvent: "slash.apply",
        });
        v.focus();
      },
    },
  ];
}

import { fuzzyFilter } from "@myne/editor/host/commands/fuzzy";

/** Shares the same scorer as the command palette (`src/commands/fuzzy.ts`)
 *  so slash menu + palette have identical ranking semantics. */
export function filterCommands(
  commands: readonly SlashCommand[],
  query: string,
): readonly SlashCommand[] {
  const candidates = commands.map((cmd) => ({
    item: cmd,
    haystacks: [cmd.id, cmd.label],
  }));
  return fuzzyFilter(candidates, query).map((m) => m.item);
}
