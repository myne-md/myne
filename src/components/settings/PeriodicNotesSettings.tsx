// Settings → Editor: periodic-notes configuration (MYND-191 daily; myne#177
// weekly and monthly). One "Periodic notes" block with a Daily, a Weekly and a
// Monthly section, each carrying the same three controls: folder, title format
// and template. Each persists **disk-first** via the prefs setters (the write
// completes before the command returns); designating a folder also registers it
// as a deliberate folder so it survives empty.
//
// Daily writes its three legacy top-level prefs fields and the other two write
// the `periodic_notes` map. That asymmetry is the no-migration decision, not an
// oversight: `vault.prefs` merges per field, so a device on an older build would
// keep writing `daily_folder` while a newer one wrote `periodic_notes` and
// nothing could say which is authoritative (`protocol.md` §9.5).
//
// Placement: rendered inside the Editor panel (`EditorPanel.tsx`), since this is note-
// authoring behaviour, not visual appearance. Disk-first + no in-flight gating,
// matching the other Editor-panel controls. The three sections use the existing
// `SettingsSection` primitive rather than a new grouping affordance; nothing
// visual is invented here.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import { HELPER_STYLE } from "./panel-styles";
import { Input } from "../primitives/Input";
import { SearchableSelect } from "../primitives/SearchableSelect";
import type { SelectOption } from "../primitives/Select";
import {
  prefsRead,
  setDailyDateFormat,
  setDailyFolder,
  setDailyTemplate,
  setPeriodicNoteSetting,
} from "../../lib/prefs";
import { listTemplates, type TitleRecord } from "../../notes";
import { listFolderPaths, resolveFolderOption, type FolderPathOption } from "../../notes/listFolderPaths";
import {
  PERIODS,
  PERIOD_DEFAULTS,
  periodSettings,
  periodRange,
  formatDailyDate,
  type Period,
} from "../../notes";
import { foldSegment, folderKey } from "../../dialect/folderPath";
import type { PeriodSettings } from "../../notes";
import i18n from "../../i18n";

// The "blank" sentinel option value, distinct from any note UUID; maps to a
// null template pref (an empty note titled with the period).
const BLANK_TEMPLATE = "";

/** The three things a period configures. Named because the error map, the
 *  message map and `persist` all key on it. */
type PeriodSetting = "folder" | "format" | "template";

/** The three section HEADINGS, panel level, so each says what it is a section
 *  of ("Daily notes", not "Daily"). */
const SECTION_KEY: Record<Period, string> = {
  daily: "settings.dailyNotes.sectionDaily",
  weekly: "settings.dailyNotes.sectionWeekly",
  monthly: "settings.dailyNotes.sectionMonthly",
};

/** The bare period WORD, for the copy that interpolates it. Separate from the
 *  heading because reusing that would produce "each daily notes note". */
const PERIOD_NAME_KEY: Record<Period, string> = {
  daily: "settings.dailyNotes.periodNameDaily",
  weekly: "settings.dailyNotes.periodNameWeekly",
  monthly: "settings.dailyNotes.periodNameMonthly",
};

/** The ACCESSIBLE name of each control, which names its period. `SettingRow`
 *  renders its label as a plain span with no `htmlFor`, so the `aria-label` is
 *  the whole accessible name, and nine controls sharing three of them leaves a
 *  screen reader's controls list with three "Folder"s. The VISIBLE label stays
 *  short, because the section heading already says which period it is. */
const ARIA_LABEL_KEY: Record<PeriodSetting, string> = {
  folder: "settings.dailyNotes.periodFolderAriaLabel",
  format: "settings.dailyNotes.periodFormatAriaLabel",
  template: "settings.dailyNotes.periodTemplateAriaLabel",
};

const FORMAT_HELPER_KEY: Record<Period, string> = {
  daily: "settings.dailyNotes.periodFormatHelperDaily",
  weekly: "settings.dailyNotes.periodFormatHelperWeekly",
  monthly: "settings.dailyNotes.periodFormatHelperMonthly",
};

function templateName(rec: TitleRecord): string {
  return rec.title?.trim() || i18n.t("settings.dailyNotes.untitledTemplate");
}

/** Persist one setting for one period. Daily routes to its three legacy
 *  setters; the others write one `periodic_notes` entry each. */
async function persist(
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

/**
 * Two periods that resolve to the same note, because the match rule is folder +
 * title and nothing else. That is not a bug to special-case in the resolver: it
 * is a configuration the user made. But it has to be visible at the moment it is
 * made, or "open this month opened my daily note" reads as a defect. Compares
 * the EFFECTIVE values, so two periods left on different defaults do not warn
 * and two explicitly set to the same thing do.
 *
 * Asks the resolver's own question rather than comparing the settings as typed.
 * The resolver folds (case-fold + NFC) and matches the RENDERED title, so a raw
 * string compare missed three real collisions: `Daily/` against `daily/`,
 * `gggg-[W]ww` against `gggg-[w]ww`, and any two different formats that render
 * the same title.
 */
// Two probe dates, and a match on either is a collision. `PROBE_ALIGNED` is a
// Monday that is also the 1st, so all three period anchors land on it and a
// pair that shares a note only on such a day is still caught; `PROBE_MIDWEEK`
// is a Wednesday mid-month, where the three anchors are three different days.
// Neither is "now": the answer must not depend on which day the user opens
// Settings.
const PROBE_ALIGNED = new Date(2026, 5, 1);
const PROBE_MIDWEEK = new Date(2026, 5, 17);

export function collidingPeriods(
  effective: Record<Period, { folder: string; format: string }>,
): [Period, Period] | null {
  const folderOf = (p: Period): string => folderKey(effective[p].folder);
  const titlesOf = (p: Period): string[] =>
    [PROBE_ALIGNED, PROBE_MIDWEEK].map((probe) =>
      foldSegment(formatDailyDate(periodRange(probe, p).anchor, effective[p].format)),
    );
  for (let i = 0; i < PERIODS.length; i += 1) {
    for (let j = i + 1; j < PERIODS.length; j += 1) {
      const a = PERIODS[i]!;
      const b = PERIODS[j]!;
      if (folderOf(a) !== folderOf(b)) continue;
      const [ta, tb] = [titlesOf(a), titlesOf(b)];
      if (ta.some((title, k) => title === tb[k])) return [a, b];
    }
  }
  return null;
}

export function PeriodicNotesSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Record<Period, PeriodSettings>>({
    daily: { folder: null, format: null, template: null },
    weekly: { folder: null, format: null, template: null },
    monthly: { folder: null, format: null, template: null },
  });
  // What the vault last ACCEPTED. `settings` is the edited value, which by the
  // time an onBlur fires is already the new one, so a refused write has nothing
  // to put back without this. Seeded from the read, advanced on every write
  // that succeeds.
  const [persisted, setPersisted] = useState<Record<Period, PeriodSettings>>({
    daily: { folder: null, format: null, template: null },
    weekly: { folder: null, format: null, template: null },
    monthly: { folder: null, format: null, template: null },
  });
  const [folderPaths, setFolderPaths] = useState<FolderPathOption[]>([]);
  const [templates, setTemplates] = useState<TitleRecord[]>([]);
  // Keyed `<period>.<setting>`, not by period: the message has to render under
  // the control that failed, and this component draws three of each. Keyed by
  // period alone, a failed weekly FOLDER write rendered under Weekly, Template.
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    let cancelled = false;
    void listFolderPaths()
      .then((paths) => {
        if (!cancelled) setFolderPaths(paths);
      })
      .catch(() => {
        // Locked vault or read failure. The free-text fallback still renders.
      });
    void prefsRead()
      .then((prefs) => {
        if (cancelled) return;
        const read = {
          daily: periodSettings(prefs, "daily"),
          weekly: periodSettings(prefs, "weekly"),
          monthly: periodSettings(prefs, "monthly"),
        };
        setSettings(read);
        setPersisted(read);
      })
      .catch(() => {
        /* keep blank-as-default on read failure */
      });
    void listTemplates()
      .then((recs) => {
        if (!cancelled) setTemplates(recs);
      })
      .catch(() => {
        /* designator shows only "Blank" if templates can't be listed */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (period: Period, patch: Partial<PeriodSettings>) =>
    setSettings((prev) => ({ ...prev, [period]: { ...prev[period], ...patch } }));

  const errorKeyOf = (period: Period, setting: PeriodSetting): string =>
    `${period}.${setting}`;

  const SAVE_ERROR_KEY: Record<PeriodSetting, string> = {
    folder: "settings.dailyNotes.periodFolderSaveError",
    format: "settings.dailyNotes.periodFormatSaveError",
    template: "settings.dailyNotes.periodTemplateSaveError",
  };

  /**
   * Persist one setting, and on refusal put the message under THAT control and
   * put the control back to what disk holds. The revert is the half that is
   * easy to skip: without it the select still shows the value the user picked
   * while the vault holds the old one, which is the same screen a successful
   * write produces.
   */
  async function save(
    period: Period,
    setting: PeriodSetting,
    value: string | null,
    previous: string | null,
  ) {
    const key = errorKeyOf(period, setting);
    setErrors((prev) => ({ ...prev, [key]: undefined }));
    try {
      await persist(period, setting, value);
      setPersisted((prev) => ({ ...prev, [period]: { ...prev[period], [setting]: value } }));
    } catch {
      update(period, { [setting]: previous } as Partial<PeriodSettings>);
      setErrors((prev) => ({
        ...prev,
        [key]: t(SAVE_ERROR_KEY[setting], {
          period: t(PERIOD_NAME_KEY[period]),
        }),
      }));
    }
  }

  // The default folders are always offerable even when no note is filed there
  // yet (a fresh vault has no `Weekly/` until the first weekly note is written).
  const folderOptions: SelectOption<string>[] = useMemo(() => {
    const opts = folderPaths.map((f) => ({ value: f.path, label: f.label }));
    for (const period of PERIODS) {
      const fallback = PERIOD_DEFAULTS[period].folder;
      if (!opts.some((o) => o.value === fallback)) {
        opts.unshift({ value: fallback, label: fallback });
      }
    }
    return opts;
  }, [folderPaths]);

  const templateOptions: SelectOption<string>[] = [
    { value: BLANK_TEMPLATE, label: t("settings.dailyNotes.blankTemplate") },
    ...templates.map((rec) => ({ value: rec.noteUuid, label: templateName(rec) })),
  ];

  const effective = useMemo(() => {
    const out = {} as Record<Period, { folder: string; format: string }>;
    for (const period of PERIODS) {
      out[period] = {
        folder: settings[period].folder?.trim() || PERIOD_DEFAULTS[period].folder,
        format: settings[period].format?.trim() || PERIOD_DEFAULTS[period].format,
      };
    }
    return out;
  }, [settings]);
  const collision = collidingPeriods(effective);

  return (
    <>
      {collision !== null && (
        <p
          role="status"
          data-testid="settings.periodic-collision-warning"
          style={{
            // Composes the shared helper style rather than growing an eighth
            // private paragraph, which is the duplication `panel-styles.ts`
            // exists to stop. The ink is one step brighter than a helper's,
            // deliberately: this is a warning, not an explanation.
            ...HELPER_STYLE,
            color: "var(--fg-2)",
          }}
        >
          {t("settings.dailyNotes.collisionWarning", {
            first: t(PERIOD_NAME_KEY[collision[0]]),
            second: t(PERIOD_NAME_KEY[collision[1]]),
          })}
        </p>
      )}
      {PERIODS.map((period) => (
        <SettingsSection
          key={period}
          title={t(SECTION_KEY[period])}
          testId={`settings.periodic-section-${period}`}
        >
          <SettingRow
            anchorId={`editor.${period}-notes-folder`}
            label={t("settings.dailyNotes.periodFolderLabel")}
            error={errors[errorKeyOf(period, "folder")] ?? null}
            helper={t("settings.dailyNotes.periodFolderHelper", {
              period: t(PERIOD_NAME_KEY[period]),
              default: PERIOD_DEFAULTS[period].folder,
            })}
            control={
              /* Pick an existing folder rather than typing its path (MYND-624):
                 getting it right otherwise means spelling the canonical
                 trailing-slash form from memory, and a typo silently files the
                 notes somewhere new. The free-text input stays as the fallback
                 for a vault with no folders yet, where a one-option dropdown
                 would be worse than a field. */
              folderPaths.length > 0 ? (
                <SearchableSelect
                  options={folderOptions}
                  selected={[
                    resolveFolderOption(
                      folderOptions.map((o) => o.value),
                      settings[period].folder || PERIOD_DEFAULTS[period].folder,
                    ),
                  ]}
                  onChange={(next) => {
                    const chosen = next[0];
                    if (chosen === undefined) return;
                    const previous = persisted[period].folder;
                    update(period, { folder: chosen });
                    void save(period, "folder", chosen, previous);
                  }}
                  aria-label={t(ARIA_LABEL_KEY.folder, { period: t(PERIOD_NAME_KEY[period]) })}
                  testId={`settings.${period}-folder-select`}
                  searchPlaceholder={t("settings.dailyNotes.folderSearchPlaceholder")}
                  emptyText={t("settings.dailyNotes.folderSearchEmpty")}
                />
              ) : (
                <Input
                  value={settings[period].folder ?? ""}
                  placeholder={PERIOD_DEFAULTS[period].folder}
                  onChange={(e) => update(period, { folder: e.target.value })}
                  onBlur={() => {
                    const value = settings[period].folder?.trim() ?? "";
                    if (value === "") return; // empty → leave the default
                    void save(period, "folder", value, persisted[period].folder);
                  }}
                  aria-label={t(ARIA_LABEL_KEY.folder, { period: t(PERIOD_NAME_KEY[period]) })}
                  data-testid={`settings.${period}-folder-input`}
                />
              )
            }
          />
          <SettingRow
            anchorId={`editor.${period}-notes-date-format`}
            label={t("settings.dailyNotes.periodFormatLabel")}
            error={errors[errorKeyOf(period, "format")] ?? null}
            helper={
              period === "weekly"
                ? `${t(FORMAT_HELPER_KEY[period], { default: PERIOD_DEFAULTS[period].format })} ${t("settings.dailyNotes.weekStartNote")}`
                : t(FORMAT_HELPER_KEY[period], { default: PERIOD_DEFAULTS[period].format })
            }
            control={
              <Input
                value={settings[period].format ?? ""}
                placeholder={PERIOD_DEFAULTS[period].format}
                mono
                onChange={(e) => update(period, { format: e.target.value })}
                onBlur={() => {
                  const value = settings[period].format?.trim() ?? "";
                  if (value === "") return; // empty → leave the default
                  void save(period, "format", value, persisted[period].format);
                }}
                aria-label={t(ARIA_LABEL_KEY.format, { period: t(PERIOD_NAME_KEY[period]) })}
                data-testid={`settings.${period}-format-input`}
              />
            }
          />
          <SettingRow
            anchorId={`editor.${period}-notes-template`}
            label={t("settings.dailyNotes.periodTemplateLabel")}
            helper={t("settings.dailyNotes.periodTemplateHelper", {
              period: t(PERIOD_NAME_KEY[period]),
            })}
            error={errors[errorKeyOf(period, "template")] ?? null}
            control={
              <SearchableSelect
                options={templateOptions}
                selected={[settings[period].template ?? BLANK_TEMPLATE]}
                onChange={(next) => {
                  const chosen = next[0] ?? BLANK_TEMPLATE;
                  const value = chosen === BLANK_TEMPLATE ? null : chosen;
                  const previous = persisted[period].template;
                  update(period, { template: value });
                  void save(period, "template", value, previous);
                }}
                aria-label={t(ARIA_LABEL_KEY.template, { period: t(PERIOD_NAME_KEY[period]) })}
                testId={`settings.${period}-template-select`}
                searchPlaceholder={t("settings.dailyNotes.searchPlaceholder")}
                emptyText={t("settings.dailyNotes.searchEmpty")}
              />
            }
          />
        </SettingsSection>
      ))}
    </>
  );
}
