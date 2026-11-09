// Settings → Editor: periodic-notes configuration (MYND-191 daily; myne#177
// weekly and monthly). ONE "Periodic notes" block with a period switcher at the
// top (Daily / Weekly / Monthly) and only the selected period's three controls
// rendered: folder, title format and template. Each persists **disk-first** via
// the prefs setters (the write completes before the command returns);
// designating a folder also registers it as a deliberate folder so it survives
// empty.
//
// Daily writes its three legacy top-level prefs fields and the other two write
// the `periodic_notes` map. That asymmetry is the no-migration decision, not an
// oversight: `vault.prefs` merges per field, so a device on an older build would
// keep writing `daily_folder` while a newer one wrote `periodic_notes` and
// nothing could say which is authoritative (`protocol.md` §9.5).
//
// # Why a switcher rather than three stacked sections
//
// Three periods × three rows with a two-line helper under each is nine rows and
// roughly 750px — a third of the Editor panel — and the helpers repeat the same
// sentence once per period. Only one period's worth of it is ever being read at
// a time, so the other two are height that buys nothing. Daily is the common
// case (it is the only period with legacy top-level prefs and the only one that
// shipped first), so the block opens on Daily.
//
// The switcher is a `Segmented` and NOT a `SettingRow` control, and that is
// deliberate rather than a canon violation: `docs/design/README.md` "Which
// picker" bans a segmented control INSIDE a row (it makes the right edge ragged
// and varies row height by option count), while this is a section-level choice
// with three short captions — the same shape `GraphView`'s toolbar cluster uses.
//
// # The switcher and the settings search
//
// This is the part the tabs OWE, and skipping it fails silently. Settings search
// resolves an entry to its `data-setting-anchor` and scrolls to it (MYND-536).
// Six of this block's nine anchors belong to a period that is not selected, so a
// search hit on "weekly template" would find no element, and `SettingsModal`'s
// resolver would degrade to a bare panel switch with nothing highlighted — the
// same failure `developerGated` exists to prevent for capability-gated entries
// (MYND-593), caused here by a tab. `focusAnchorId` closes it: the shell threads
// the pending target in, and the switcher moves to that period's tab in the SAME
// render, before the resolver reads the DOM. See `periodOfAnchor`.
//
// Placement: rendered inside the Editor panel (`EditorPanel.tsx`), since this is
// note-authoring behaviour, not visual appearance. Disk-first + no in-flight
// gating, matching the other Editor-panel controls.

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import { HELPER_STYLE } from "./panel-styles";
import { Input } from "../primitives/Input";
import { SearchableSelect } from "../primitives/SearchableSelect";
import { Segmented } from "../primitives/Segmented";
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

/** The block's own heading. The three period names are the switcher's captions
 *  now (`SECTION_KEY`), so the section needs a name of its own. */
const SECTION_TITLE_KEY = "settings.dailyNotes.sectionPeriodic";

/** The switcher's accessible name. The captions name the periods but not what
 *  choosing one DOES, and nine controls share three labels, so this is the only
 *  place that says the choice is which period you are editing. */
const SWITCHER_ARIA_KEY = "settings.dailyNotes.periodSwitcherAriaLabel";

/**
 * Which period a settings-search anchor belongs to, or `null` for one this block
 * does not own.
 *
 * Reverses this panel's OWN anchor format (`editor.<period>-notes-<setting>`, the
 * `anchorId`s passed to `SettingRow` below), which is why the prefix is parsed
 * here rather than published somewhere central: the format has one owner and one
 * consumer.
 *
 * Exported because it is the testable half of the switcher/search contract — an
 * anchor added later with no matching period fails a test rather than silently
 * scrolling nowhere.
 */
export function periodOfAnchor(anchorId: string): Period | null {
  for (const period of PERIODS) {
    if (anchorId.startsWith(`editor.${period}-notes-`)) return period;
  }
  return null;
}

function templateName(rec: TitleRecord): string {
  return rec.title?.trim() || i18n.t("common.untitledtemplate");
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

// The "show me the other one" affordance in the collision warning, and a RAW
// `<button>` on purpose rather than a `Button` primitive.
//
// `check-primitive-adoption` counts it, and this is the comment that guard's own
// message asks for. `Button` is not the right component here: every variant
// carries `--control-pad-y/x` padding, `--radius-2` and a `--bg-3` hover BLOCK,
// which inside a sentence reads as a chip wedged between two clauses. What this
// is, is a text link — accent ink, underline, a colour shift on hover — and that
// shape has no primitive. `AboutPanel.tsx`'s two documentation links are the same
// element and are recorded the same way (`primitive-adoption.json`).
//
// The style mirrors `AboutPanel`'s `LINK_STYLE`; `font: "inherit"` keeps the
// control in the warning paragraph's own type ramp.
const JUMP_LINK_STYLE: CSSProperties = {
  font: "inherit",
  color: "var(--accent)",
  textDecoration: "underline",
  background: "none",
  border: 0,
  padding: 0,
  cursor: "pointer",
  transition: "color var(--duration-fast) var(--ease-standard)",
};

/** Hover for {@link JUMP_LINK_STYLE}: an underlined accent link registers
 *  pointer-over by COLOUR, not by a background block, and
 *  `e.currentTarget.style` is what React re-applies on the next render — the
 *  same shape `AboutPanel.linkHover` uses. Written as one const and spread at
 *  the element, so a second handler can never silently replace one of these
 *  (`src/AGENTS.md`: a spread after a hand-written `onMouseEnter` replaces it). */
const JUMP_LINK_HOVER = {
  onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => {
    e.currentTarget.style.color = "var(--accent-hover)";
  },
  onMouseLeave: (e: ReactMouseEvent<HTMLElement>) => {
    e.currentTarget.style.color = "var(--accent)";
  },
};

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

export interface PeriodicNotesSettingsProps {
  /**
   * The target of a settings-search jump (MYND-536) when it is one of THIS
   * block's anchors. Owned by `SettingsModal` and threaded through
   * `EditorPanel`; without it the switcher would render whichever period the
   * user last chose, and six of the nine anchors would be unrenderable at the
   * moment the shell resolves them. See the file header.
   */
  focusAnchorId?: string;
}

export function PeriodicNotesSettings({
  focusAnchorId,
}: PeriodicNotesSettingsProps = {}) {
  const { t } = useTranslation();
  /** The period whose three rows are rendered. Daily by default: the common
   *  case, and the only period that predates myne#177. */
  const [period, setPeriod] = useState<Period>("daily");
  /** The search target the switcher has already moved for, so a re-render that
   *  leaves `focusAnchorId` unchanged cannot re-assert an old jump. */
  const [adoptedAnchor, setAdoptedAnchor] = useState<string | undefined>(undefined);

  // Adopt a search target DURING RENDER, and that is the whole point of not
  // using an effect. `SettingsModal` resolves the anchor in its own
  // `useEffect` + `requestAnimationFrame`; an effect here would run in the
  // child-first passive flush and its state write would schedule a re-render
  // whose commit races that read. A render-phase write makes React re-render
  // this component immediately, so the target period's rows are in the DOM
  // before ANY effect runs. This is React's documented "adjusting state when a
  // prop changes" pattern, not a loop: the guard on `adoptedAnchor` fires once
  // per distinct target.
  if (focusAnchorId === undefined) {
    // The shell clears its pending target once it has scrolled. Reset with it,
    // or a second search to the SAME anchor would compare equal and skip the
    // adoption, leaving the jump to land on nothing.
    if (adoptedAnchor !== undefined) setAdoptedAnchor(undefined);
  } else if (focusAnchorId !== adoptedAnchor) {
    setAdoptedAnchor(focusAnchorId);
    const target = periodOfAnchor(focusAnchorId);
    if (target !== null && target !== period) setPeriod(target);
  }

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

  // Which period the warning offers to jump to: the member of the colliding pair
  // the visible tab is NOT on. Needed only because of the tabs — the warning
  // names two periods and only one of them can have rows on screen, so without
  // this the user is told about a collision they cannot look at.
  const collisionTarget: Period | null =
    collision === null ? null : collision[0] === period ? collision[1] : collision[0];

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
          })}{" "}
          <button
            type="button"
            data-testid="settings.periodic-collision-jump"
            {...JUMP_LINK_HOVER}
            style={JUMP_LINK_STYLE}
            onClick={() => {
              if (collisionTarget !== null) setPeriod(collisionTarget);
            }}
          >
            {/* The switcher's own caption, so the sentence and the control it
                points at say the same words. */}
            {t(SECTION_KEY[collisionTarget ?? collision[0]])}
          </button>
        </p>
      )}
      <SettingsSection
        title={t(SECTION_TITLE_KEY)}
        testId={`settings.periodic-section-${period}`}
      >
        {/* The period switcher. Two-thirds of this block's height used to be the
            two periods nobody was currently reading. See the file header for why
            this is a `Segmented` and not a `SettingRow` control. */}
        <Segmented
          options={PERIODS.map((p) => ({ value: p, label: t(SECTION_KEY[p]) }))}
          value={period}
          onChange={(next) => setPeriod(next as Period)}
          ariaLabel={t(SWITCHER_ARIA_KEY)}
          testId="settings.periodic-period"
        />
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
    </>
  );
}
