// Periodic-notes settings on mobile: daily, weekly and monthly (myne-md/myne#880).
//
// # Why this block exists
//
// `mobile/src/lib/daily.ts` resolves a period note's folder, title format and
// template out of `vault.prefs`, and until this landed NOTHING on this client
// could write any of them: a phone inherited whatever a computer had set. The
// daily three were recorded in `scripts/ipc-binding-callers.json` as "a live
// defect rather than a gap", and `set_periodic_note_setting` was recorded
// nowhere, which is the argument for the parity projection existing at all.
//
// # Which client's value each control changes
//
// All four settings are SHARED (`sync-protocol.md` §10.2): `daily_folder`,
// `daily_date_format` and `daily_template` are `ScalarLww`, and the
// `periodic_notes` entries merge per key. So an edit here reaches the user's
// other devices and an edit there reaches this one. The block says so in one
// sentence rather than leaving the reader to guess, because its neighbours in
// the same panel are a mix: `timezone` is device-local and `date_format` is
// shared, and the two behave differently after a write.
//
// # The daily/periodic asymmetry is inherited, not invented
//
// Daily writes its three legacy top-level fields; weekly and monthly write one
// `periodic_notes` entry each. That is the no-migration decision recorded in
// `src/components/settings/PeriodicNotesSettings.tsx`, and this block reproduces
// it deliberately: `vault.prefs` merges per field, so a device on an older build
// would keep writing `daily_folder` while a newer one wrote `daily.*` into the
// map, and nothing could say which is authoritative.
//
// # Shape
//
// One period selector and three controls, rather than the desktop's three
// stacked sections. Mobile's settings stay on their own primitives
// (`docs/decisions/ui/0626`), and a phone cannot afford three copies of three
// labelled fields inside one panel.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Segmented, TextField } from "./inputs";
import { PERIODS, PERIOD_DEFAULTS, periodSettings, type Period, type PeriodPrefs } from "../lib/daily";
import { noteList, noteRead } from "../lib/notes";
import { readNoteFlags, isListedTemplate } from "../lib/note-organize";
import { deriveTitleSnippet } from "../lib/note-title";
import {
  setDailyDateFormat,
  setDailyFolder,
  setDailyTemplate,
  setPeriodicNoteSetting,
} from "../lib/prefs";

/** The three things a period configures, matching the desktop component's own
 *  union so the two `persist` functions read the same way. */
type PeriodSetting = "folder" | "format" | "template";

const PERIOD_NAME_KEY: Record<Period, string> = {
  daily: "settings.dailyNotes.periodNameDaily",
  weekly: "settings.dailyNotes.periodNameWeekly",
  monthly: "settings.dailyNotes.periodNameMonthly",
};

/** The per-period helper sentence, which also carries that period's default. */
const FORMAT_HELPER_KEY: Record<Period, string> = {
  daily: "settings.dailyNotes.periodFormatHelperDaily",
  weekly: "settings.dailyNotes.periodFormatHelperWeekly",
  monthly: "settings.dailyNotes.periodFormatHelperMonthly",
};

/**
 * Persist one setting for one period. Daily routes to its three legacy setters;
 * the others write one `periodic_notes` entry each.
 *
 * Exported so the spec can drive the routing directly as well as through the
 * controls: the routing IS the behaviour, and a test that only clicked a field
 * would be asserting the field.
 */
export async function persistPeriodSetting(
  period: Period,
  setting: PeriodSetting,
  value: string | null,
): Promise<void> {
  if (period === "daily") {
    if (setting === "folder") return setDailyFolder(value ?? "");
    if (setting === "format") return setDailyDateFormat(value ?? "");
    return setDailyTemplate(value);
  }
  return setPeriodicNoteSetting(period, setting, value);
}

/** Every note flagged `template: true`, as `{ id, title }`.
 *
 * The same two reads the desktop `listTemplates` makes (`noteList` then a batch
 * load), so a phone's picker offers what a computer's does. Mobile has no batched
 * read command, so the batch is a `Promise.all`; a note that fails to read is
 * skipped rather than failing the picker.
 *
 * **The cost is the desktop's, on purpose** (myne-md/myne#867 review, D7): a
 * read per note, once per mount, decrypted only to read the `template` flag.
 * It is what `PeriodicNotesSettings.tsx` pays through `listTemplates()` on the
 * computer, and a phone-only shortcut would be a second definition of "is a
 * template" that could disagree with it. A host-side flag index serving both
 * clients is the fix that removes the cost for both, not a mobile copy. */
export async function listTemplateNotes(): Promise<{ id: string; title: string }[]> {
  const ids = await noteList();
  const bodies = await Promise.all(ids.map((id) => noteRead(id).catch(() => "")));
  const out: { id: string; title: string }[] = [];
  ids.forEach((id, i) => {
    const body = bodies[i] ?? "";
    if (!isListedTemplate(readNoteFlags(body))) return;
    out.push({ id, title: deriveTitleSnippet(body).title });
  });
  return out;
}

const HINT_STYLE = {
  marginTop: "var(--space-3)",
  fontSize: "var(--text-xs)",
  lineHeight: 1.5,
  color: "var(--fg-3)",
} as const;

const LABEL_STYLE = {
  marginTop: "var(--space-4)",
  marginBottom: "var(--space-2)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--fg-3)",
} as const;

const TEMPLATE_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  padding: "var(--space-3)",
  borderTop: "1px solid var(--line-1)",
  background: "none",
  color: "var(--fg-1)",
  cursor: "pointer",
  textAlign: "left",
} as const;

const TEMPLATE_GROUP_STYLE = {
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  overflow: "hidden",
} as const;

// The platform's minimum touch target, `--m-touch` (myne-md/myne#867 review,
// D6): a bare text control is only as tall as one line of small text, a
// roughly 12px target for the one press that saves or removes. The glyph stays
// where it was; the box around it grows.
const COMMIT_BUTTON_STYLE = {
  background: "none",
  border: "none",
  color: "var(--accent)",
  cursor: "pointer",
  padding: 0,
  minWidth: "var(--m-touch)",
  minHeight: "var(--m-touch)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

export function PeriodicNotesBlock({
  prefs,
  onToast,
}: {
  prefs: PeriodPrefs;
  /** The sheet's toast. A failed write is REPORTED and the field rolled back to
   *  what the vault holds: the desktop twin does both
   *  (`PeriodicNotesSettings` catches, restores the previous value and shows a
   *  per-setting error). Without it the phone keeps the path the user typed
   *  while `vault.prefs` keeps the old one. */
  onToast?: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>("daily");
  const settings = periodSettings(prefs, period);
  const defaults = PERIOD_DEFAULTS[period];

  // The two text fields commit on Enter, on the trailing commit control, or when
  // the field loses focus (myne-md/myne#867 review, D7: a folder typed and the
  // sheet closed was otherwise lost with nothing saying so), rather than per
  // keystroke: a folder path typed one character at a time would be a
  // prefs write and a nonce bump per character, and a folder write registers the
  // folder as deliberate backend-side every time.
  const [folderDraft, setFolderDraft] = useState(settings.folder ?? defaults.folder);
  const [formatDraft, setFormatDraft] = useState(settings.format ?? defaults.format);
  const [templates, setTemplates] = useState<{ id: string; title: string }[]>([]);

  // Re-seed when the period changes or the stored value moves underneath (a sync
  // arriving while the panel is open), so a field never shows a value the vault
  // does not hold.
  const storedFolder = settings.folder;
  const storedFormat = settings.format;
  const defaultFolder = defaults.folder;
  const defaultFormat = defaults.format;
  useEffect(() => {
    setFolderDraft(storedFolder ?? defaultFolder);
  }, [period, storedFolder, defaultFolder]);
  useEffect(() => {
    setFormatDraft(storedFormat ?? defaultFormat);
  }, [period, storedFormat, defaultFormat]);

  useEffect(() => {
    let cancelled = false;
    void listTemplateNotes()
      .then((rows) => {
        if (!cancelled) setTemplates(rows);
      })
      .catch(() => {
        // A failed list is an empty picker rather than a broken panel: the
        // template setting is one of three on this screen, and losing the other
        // two to it would be the worse trade. `Blank` is always offered, so the
        // row stays usable and the setting stays clearable.
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = useMemo(
    () =>
      (setting: "folder" | "format") => {
        const draft = setting === "folder" ? folderDraft : formatDraft;
        const stored = setting === "folder" ? storedFolder : storedFormat;
        const fallback = setting === "folder" ? defaultFolder : defaultFormat;
        // Only write when it would change something: a commit with no edit is
        // not an edit, and every write stamps a fresh field clock.
        if (draft === (stored ?? fallback)) return;
        void persistPeriodSetting(period, setting, draft || null).catch(() => {
          // Rolled back to disk truth and reported, the desktop twin's shape.
          if (setting === "folder") setFolderDraft(stored ?? fallback);
          else setFormatDraft(stored ?? fallback);
          onToast?.(t("settings.saveSettingError"));
        });
      },
    [
      folderDraft,
      formatDraft,
      period,
      storedFolder,
      storedFormat,
      defaultFolder,
      defaultFormat,
      onToast,
      t,
    ],
  );

  const periodName = t(PERIOD_NAME_KEY[period]);
  const saveLabel = t("settings.dailyNotes.mobileSaveLabel");

  return (
    <div data-testid="settings.periodicNotes">
      <Segmented
        options={PERIODS.map((p) => t(PERIOD_NAME_KEY[p]))}
        optionValues={[...PERIODS]}
        testIdPrefix="settings.periodicNotes-period"
        ariaLabel={t("settings.dailyNotes.mobilePeriodAriaLabel")}
        active={PERIODS.indexOf(period)}
        onChange={(i) => setPeriod(PERIODS[i] ?? "daily")}
        style={{ marginTop: "var(--space-2)" }}
      />

      <div style={LABEL_STYLE}>{t("settings.dailyNotes.periodFolderLabel")}</div>
      <TextField
        testId="settings.periodicNotes.folder"
        label={t("settings.dailyNotes.periodFolderAriaLabel")}
        value={folderDraft}
        onChange={setFolderDraft}
        onEnter={() => commit("folder")}
        onBlur={() => commit("folder")}
        style={{ background: "var(--bg-2)" }}
        trailing={
          <button
            type="button"
            data-testid="settings.periodicNotes.folder-commit"
            aria-label={`${saveLabel}: ${t("settings.dailyNotes.periodFolderLabel")}`}
            onClick={() => commit("folder")}
            style={COMMIT_BUTTON_STYLE}
          >
            {t("settings.dailyNotes.mobileSaveGlyph")}
          </button>
        }
      />

      <div style={LABEL_STYLE}>{t("settings.dailyNotes.periodFormatLabel")}</div>
      <TextField
        testId="settings.periodicNotes.format"
        label={t("settings.dailyNotes.periodFormatAriaLabel")}
        value={formatDraft}
        onChange={setFormatDraft}
        onEnter={() => commit("format")}
        onBlur={() => commit("format")}
        style={{ background: "var(--bg-2)" }}
        trailing={
          <button
            type="button"
            data-testid="settings.periodicNotes.format-commit"
            aria-label={`${saveLabel}: ${t("settings.dailyNotes.periodFormatLabel")}`}
            onClick={() => commit("format")}
            style={COMMIT_BUTTON_STYLE}
          >
            {t("settings.dailyNotes.mobileSaveGlyph")}
          </button>
        }
      />
      <div style={HINT_STYLE} data-testid="settings.periodicNotes.format-helper">
        {t(FORMAT_HELPER_KEY[period], { default: defaultFormat })}
      </div>

      <div style={LABEL_STYLE}>{t("settings.dailyNotes.periodTemplateLabel")}</div>
      <div style={TEMPLATE_GROUP_STYLE}>
        <button
          type="button"
          data-testid="settings.periodicNotes.template-none"
          aria-pressed={settings.template == null}
          onClick={() =>
            void persistPeriodSetting(period, "template", null).catch(() => {
              onToast?.(t("settings.saveSettingError"));
            })
          }
          style={{ ...TEMPLATE_ROW_STYLE, borderTop: "none" }}
        >
          {t("settings.dailyNotes.blankTemplate")}
        </button>
        {templates.map((row) => (
          <button
            key={row.id}
            type="button"
            data-testid={`settings.periodicNotes.template-${row.id}`}
            aria-pressed={settings.template === row.id}
            onClick={() =>
              void persistPeriodSetting(period, "template", row.id).catch(() => {
                onToast?.(t("settings.saveSettingError"));
              })
            }
            style={TEMPLATE_ROW_STYLE}
          >
            {row.title || t("common.untitledtemplate")}
          </button>
        ))}
      </div>

      {/* Which client's value this changes. The daily fields and the periodic map
          are all SHARED, so an edit here reaches the other devices, and the
          neighbours in this panel are a mix: the zone is device-local. */}
      <div style={HINT_STYLE} data-testid="settings.periodicNotes.shared-notice">
        {t("settings.dailyNotes.mobileSharedNotice", { period: periodName })}
      </div>
    </div>
  );
}
