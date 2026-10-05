import { type ChangeEvent, type CSSProperties, type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { setLanguage } from "@myne/i18n";
import { SUPPORTED_LANGUAGES, SUPPORTED_CODES, type LanguageCode } from "@myne/i18n/config";
import { Sheet, Banner, Button, Icon, Toast, StrengthMeter, Switch, Segmented, Spinner, ThemeChiplet, FolderGlyph, MyneMark } from "../../components";
import { remindersReachTheOs } from "../../lib/reminders";
import { FOLDER_ICON_NAMES } from "@myne/decorations/folderIcons";
import {
  SyncHubPanel,
  SyncEndpointPanel,
  SyncEnrollPanel,
  SyncDevicesPanel,
  SyncMembersPanel,
} from "../../components";
import { ExactAlarmBlock, ReminderSwitchBlock } from "../../components";
import { HideVaultNamesBlock, RecoveryDrillBlock } from "../../components";
import { AiConsentScreen } from "../../components";
import { MemorySection } from "./MemorySection";
import { applyTheme } from "../../formfactor/theme";
import type { ThemeName } from "../../formfactor/PlatformContext";
import { HAS_TAURI } from "../../lib/app-window";
import { isRtl } from "../../lib/util";
import { changePassword } from "../../lib/vault-change-password";
import { deleteVault } from "../../lib/vault-delete";
import {
  quickUnlockStatus,
  quickUnlockSetupPin,
  quickUnlockSetupBiometric,
  quickUnlockDisable,
  type QuickUnlockStatus,
} from "../../lib/quick-unlock";
import { usePlatform } from "../../formfactor/PlatformContext";
import { vaultExportMarkdown, defaultExportDestination } from "../../lib/export";
import { shareFile } from "../../lib/share";
import { useSyncStatus, type SyncStatus } from "../../lib/use-sync-status";
import { listCustomThemes, type CustomThemeEntry } from "../../lib/themes";
import { applyCustomTheme, clearCustomTheme, hasCustomTheme } from "../../lib/customTheme";
import { ioBanner } from "../../lib/io-banner";
import { usePrefs } from "../../lib/use-prefs";
import { useHiddenHomeTiles, setHomeTileHidden } from "../../lib/home-tiles";
import { LEGAL_LINKS, legalUrl } from "@myne/legal-urls";
import { openUrl } from "../../lib/open-url";
import { vaultDisplayLabel } from "../../lib/vault-label";
import {
  setTheme as persistTheme,
  setShowNoteTimestamps,
  setEditorTextSize,
  setEditorFontFamily,
  setEditorLineSpacing,
  setEditorDefaultViewMode,
  setEditorLineNumbers,
  setEditorFocusTypewriter,
  setEditorFocusDimInactive,
  setSpellEnabled,
  setArchiveDisabled,
  setScreenCaptureProtection,
  setTranscriptionEnabled,
  setAttachmentCompressionEnabled,
  setAutoLockTimeout,
  setVaultLabel,
  setVaultIcon,
  setEditorToolbarOrder,
  setEditorToolbarHidden,
  setCustomTheme,
  type PrefsView,
  setReminderHorizonDays,
  setRemindersEnabled,
  setDateFormat,
  setTimeFormat,
  setTimezone,
  // AI (myne-md/myne#456). `aiProviderHasKey` is the odd one: a READ that
  // answers a boolean, so the key itself never needs a getter.
  aiProviderHasKey,
  setAiEnabled,
  setAiProvider,
  setAiProviderConsent,
  setAiProviderKey,
  setAiProviderModel,
} from "../../lib/prefs";
import {
  DATE_FORMATS,
  TIME_FORMATS,
  asDateFormat,
  asTimeFormat,
  formatCivilDate,
  isSupportedTimeZone,
  type DateFormat,
  type TimeFormat,
} from "@myne/editor/host/lib/datetimeFormat";
import { useDateTimeDisplay } from "@myne/editor/host/lib/useDateTimeDisplay";
import { listProviderModels } from "../../lib/ai";
import { consentIsDeviceScoped, providerLabelOf } from "@myne/copy";
import { formatBarLabelKey, resolveFormatBarOrder } from "../../lib/formatBarItems";
import type { VaultChangePasswordError } from "../../types/vault-change-password-error";
import type { VaultId } from "../../lib/stage";
import { tappable } from "../a11y/tappable";

/**
 * Settings sheet — the wired counterpart to the static workspace `11 · Settings`
 * + `settings/` ST screens, rendered as a bottom <Sheet> over the editor.
 *
 * Theme (System/Light/Dark/AMOLED) is a UI-only preference: `applyTheme()` flips
 * the `data-theme` attribute and the choice persists to localStorage (NOT a
 * backend pref). Change-password + Delete-vault + Lock are the real wired
 * actions. All three password fields are component-local and wiped on every exit
 * path + on unmount per the secret-handling discipline.
 */

// ── Theme preference (UI-only, localStorage-persisted) ───────────────────────

type ThemeChoice = "system" | ThemeName;

export const THEME_STORAGE_KEY = "myne.theme";

const THEME_CHOICES: { key: ThemeChoice; labelKey: string }[] = [
  { key: "system", labelKey: "settings.appearance.theme.system" },
  { key: "light", labelKey: "settings.appearance.theme.light" },
  { key: "dark", labelKey: "settings.appearance.theme.dark" },
  { key: "amoled", labelKey: "settings.appearance.theme.amoled" },
];

function isThemeChoice(v: string | null): v is ThemeChoice {
  return v === "system" || v === "light" || v === "dark" || v === "amoled";
}

function applyThemeChoice(choice: ThemeChoice): void {
  if (choice === "system") {
    // Bare :root default — follow the OS via prefers-color-scheme.
    document.documentElement.removeAttribute("data-theme");
  } else {
    applyTheme(choice);
  }
}

/** Read the persisted theme choice (default "system") and apply it. Called on
 *  editor mount so a returning session respects the saved appearance.
 *
 *  A custom theme supersedes the built-in choice, and the unlock path paints it
 *  BEFORE this runs (MYND-598 task 5) — so re-asserting `data-theme` here would
 *  hand a built-in rule the specificity contest on every token the palette does
 *  not define, seconds after the palette deliberately dropped that attribute.
 *  When a palette is live this is a no-op; picking a built-in theme in Settings
 *  clears the palette first (`pickTheme`), so that path still lands here. */
export function applyStoredTheme(): void {
  if (hasCustomTheme()) return;
  if (typeof localStorage === "undefined") return;
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  applyThemeChoice(isThemeChoice(stored) ? stored : "system");
}

function readStoredChoice(): ThemeChoice {
  if (typeof localStorage === "undefined") return "system";
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return isThemeChoice(stored) ? stored : "system";
}

// ── Shared presentational bits (mirror the ST grouped-list geometry) ─────────

const rowLabel: CSSProperties = { fontSize: 16, color: "var(--fg-1)" };
/** A helper line under a group or a field. See {@link PanelHint}. */
/** The vertical stack a category panel's body sits in.
 *
 *  Hoisted from four inline copies (myne-md/myne#456): the AI panel would have
 *  been a fifth, and `scripts/check-token-adoption.mjs` counts hardcoded visual
 *  values per file with a ratchet that may shrink and never grow. One constant
 *  turns an addition into a reduction.
 */
const PANEL_STACK: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  marginTop: 4,
};
/** A helper line under a group or a field. See {@link PanelHint}. */
const HINT_STYLE: CSSProperties = {
  marginTop: 2,
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--fg-3)",
};

function SectionLabel({ children, mt = 18 }: { children: ReactNode; mt?: number }) {
  return (
    <div
      style={{
        marginTop: mt,
        padding: "0 4px 8px",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--line-3)",
      }}
    >
      {children}
    </div>
  );
}

/** The Appearance/Editor panel card — a labelled block that owns its own padding,
 *  as opposed to `Group`, which is the flush-edged container for `Row` lists. */
const CARD_STYLE: CSSProperties = {
  padding: "12px 14px",
  border: "1px solid var(--line-1)",
  borderRadius: 10,
  background: "var(--bg-1)",
};

function Group({ children }: { children: ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
      {children}
    </div>
  );
}

function Row({
  children,
  first = false,
  onClick,
  testId,
}: {
  children: ReactNode;
  first?: boolean;
  onClick?: () => void;
  testId?: string;
}) {
  return (
    <div
      // A row is a real control only when it DOES something (myne#728, task
      // 16). `tappable` returns null without an `onActivate`, so a static row
      // carries no role at all rather than announcing a button that is inert.
      {...(tappable({ onActivate: onClick }) ?? {})}
      data-testid={testId}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "13px 14px",
        borderTop: first ? undefined : "1px solid var(--line-1)",
        cursor: onClick ? "pointer" : undefined,
      }}
    >
      {children}
    </div>
  );
}

function RowChevron() {
  return (
    <svg width="8" height="13" viewBox="0 0 8 14" style={{ flex: "none" }}>
      <path d="M1 1l6 6-6 6" stroke="var(--line-2)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* Vault-icon picker grid (vault-icons). Geometry deliberately mirrors the
   folder-icon picker in `DecorationSheet` so the app's two icon grids read as
   one system; the objects are copied rather than imported so a settings panel
   never reaches into an editor sheet. */
const ICON_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(6, 1fr)",
  gap: 6,
};

const ICON_BTN_STYLE: CSSProperties = {
  width: "100%",
  aspectRatio: "1 / 1",
  padding: 0,
  borderRadius: 10,
  border: "1px solid transparent",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  color: "var(--fg-2)",
};

function FieldLabel({ children, mt }: { children: ReactNode; mt: number }) {
  return (
    <div
      style={{
        marginTop: mt,
        marginBottom: 8,
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--fg-3)",
      }}
    >
      {children}
    </div>
  );
}

/** Real text/password input styled to the design Field geometry. */
function SheetInput({
  value,
  onChange,
  onBlur,
  onKeyDown,
  ariaLabel,
  describedBy,
  type = "text",
  placeholder,
  autoFocus = false,
  mono = false,
  inputMode,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Commit point for a field whose value is validated rather than free text.
   *  Optional, so every existing caller is unchanged. */
  onBlur?: () => void;
  /** The SECOND commit point such a field needs. Blur alone is not enough on
   *  Android, where the hardware back button dismisses a sheet without ever
   *  blurring the focused input. Optional, same reason as `onBlur`. */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  type?: "text" | "password";
  placeholder?: string;
  autoFocus?: boolean;
  mono?: boolean;
  inputMode?: "numeric";
  testId?: string;
  /** Accessible NAME. A sibling `<div>` label carries no `for`, so a field
   *  without this has none at all. */
  ariaLabel?: string;
  /** Id of the element carrying this field's helper or error text. */
  describedBy?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      inputMode={inputMode}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      data-testid={testId}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      style={{
        width: "100%",
        height: 50,
        border: "1px solid var(--line-2)",
        borderRadius: 6,
        background: "var(--bg-1)",
        padding: "0 14px",
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontSize: 16,
        color: "var(--fg-1)",
        outline: "none",
        boxSizing: "border-box",
      }}
    />
  );
}

/** A labeled full-width segmented control, styled to the settings card. */
function SegmentBlock<T extends string | number>({
  label,
  options,
  labels,
  value,
  onPick,
  testId,
}: {
  label: string;
  options: readonly T[];
  labels: string[];
  value: T;
  onPick: (v: T) => void;
  testId?: string;
}) {
  const active = Math.max(0, options.indexOf(value));
  return (
    <div style={CARD_STYLE}>
      <div style={BLOCK_LABEL_STYLE}>{label}</div>
      <Segmented
        options={labels}
        active={active}
        onChange={(i: number) => onPick(options[i])}
        ariaLabel={label}
        testIdPrefix={testId}
        optionValues={options.map(String)}
      />
    </div>
  );
}

/**
 * The same card with a native `<select>` instead of a segmented control.
 *
 * **Which of the two a setting gets is decided by option COUNT, not by taste**:
 * `docs/design/README.md` puts two-to-four on Segmented and five-to-twelve on a
 * Select. Five equal-width segments inside a card about 358 px wide leaves each
 * one around 68 px, which is narrower than the shortest date sample it would
 * have to show. The date format has exactly five, which is what this block was
 * extracted for (myne-md/myne#609); the desktop twin is now also a Select for
 * that row (myne-md/myne#668), and its dialog is wide enough for one.
 *
 * Extracted rather than written a second time: `LanguageBlock` already held one
 * of these inline, hardcoding eight visual values that no custom theme could
 * reach. Both now bind to tokens through this one control.
 */
function SelectBlock<T extends string>({
  label,
  options,
  labels,
  value,
  onPick,
  helper,
  testId,
}: {
  label: string;
  options: readonly T[];
  labels: string[];
  value: T;
  onPick: (v: T) => void;
  helper?: string;
  testId: string;
}) {
  return (
    <div style={CARD_STYLE}>
      <div style={BLOCK_LABEL_STYLE}>{label}</div>
      <select
        value={value}
        onChange={(e) => onPick(e.currentTarget.value as T)}
        aria-label={label}
        data-testid={testId}
        style={SELECT_STYLE}
      >
        {options.map((o, i) => (
          <option key={o} value={o}>
            {labels[i]}
          </option>
        ))}
      </select>
      {helper === undefined ? null : <div style={SELECT_HELPER_STYLE}>{helper}</div>}
    </div>
  );
}

/** Bound to tokens rather than the eight literals `LanguageBlock` carried
 *  inline, because a literal in an inline style outranks every stylesheet and is
 *  permanently unreachable to a custom theme. */
const SELECT_STYLE: CSSProperties = {
  width: "100%",
  height: 44,
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  background: "var(--bg-1)",
  padding: "0 var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-md)",
  color: "var(--fg-1)",
  cursor: "pointer",
  appearance: "none",
  WebkitAppearance: "none",
};

/** The id the zone field's `aria-describedby` points at, so the helper line
 *  and the refusal message are part of the field's description. */
const ZONE_HELP_ID = "settings-datetime-zone-help";

const SELECT_HELPER_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  lineHeight: 1.4,
};

/** The label above a full-width control inside a settings card. Extracted from
 *  {@link SegmentBlock} when a second card needed the identical heading, rather
 *  than copied: two hand-written copies of one heading is how two settings rows
 *  end up a pixel apart. Bound to tokens, since a literal in an inline style
 *  outranks every stylesheet and is unreachable to any custom theme. */
const BLOCK_LABEL_STYLE: CSSProperties = {
  fontSize: "var(--text-md)",
  marginBottom: "var(--space-2)",
  color: "var(--fg-1)",
};


/**
 * Settings → Editor date & time (myne#279, reached mobile in myne-md/myne#609).
 *
 * Three rows over `date_format` / `time_format` / `timezone`, deliberately the
 * desktop's own copy keys (`settings.dateTime.*`), which are already translated
 * into all 31 catalogs. A second set of strings for the same three settings is
 * two things to keep in step and one of them would drift on the first copy edit.
 *
 * Each vocabulary is CLOSED, the same reasoning that keeps the recurrence
 * vocabulary closed: a free-text pattern string is a mini-language to validate,
 * localize and round-trip, for a setting most people set once.
 *
 * The date options carry a WORKED EXAMPLE rather than a name, because what the
 * output looks like is the entire question the setting answers. The sample is
 * rendered through the same formatter the chips and rows use, so the preview
 * cannot disagree with the result.
 *
 * The timezone row is worth reading twice, because what it does is narrower
 * than it looks and because it is the one of the three a computer's choice never
 * overwrites here. `date_format` and `time_format` are shared scalar-LWW and
 * arrive by sync from whichever device set them last; `timezone` is device-local
 * by an explicit decision, since the right zone is a property of where a device
 * IS, so a phone that travels and a computer that does not should not have to
 * agree.
 *
 * Be exact about what device-local buys, because the looser claim was written
 * here first: it is a MERGE classification (`PrefClass::DeviceLocal`,
 * sync-protocol.md 10.2), not a transmission one. The zone never enters a `.myn`
 * file, so a note never records where its author was, but it DOES live in the
 * encrypted `vault.prefs` blob, which is pushed and pulled like every other
 * prefs field; what device-local means is that the local value survives the
 * merge, and 10.2.1 has a newly enrolled device adopt it as a starting default.
 *
 * It decides what counts as "today" and how a real instant prints. A time
 * written in a note is never converted: 09:00 reads 09:00 everywhere.
 */
function DateTimeBlock({
  dateFormat,
  timeFormat,
  timezone,
  onDate,
  onTime,
  onZone,
}: {
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  timezone: string;
  /** All three take the STORED shape, not the control's: `null` is "no explicit
   *  choice", which is what the blob omits. The mapping lives here rather than
   *  at the call site, where it was written four times and had to agree; `onZone`
   *  already had this contract and the other two now match it. */
  onDate: (v: DateFormat | null) => void;
  onTime: (v: TimeFormat | null) => void;
  /** @param onFailed run when the write is rejected, so this block can put the
   *   stored zone back into its own text state. The two above need none: they
   *   render straight off the prop. */
  onZone: (v: string | null, onFailed: () => void) => void;
}) {
  const { t } = useTranslation();
  const display = useDateTimeDisplay();
  // A fixed sample, so every option is compared on the same date rather than on
  // whatever today happens to be.
  const SAMPLE_DATE = "2026-08-01";
  // Seeded once. There is no effect mirroring the prop, deliberately: the first
  // version had one, justified as "follow a sync arriving, another surface
  // writing", and both are impossible for this field. `timezone` is device-local
  // so it never arrives by sync, and this sheet is the only place on mobile that
  // can set it. So the only thing that moves the prop is `commitZone` below,
  // which sets the text itself.
  const [zoneText, setZoneText] = useState(timezone);
  const [zoneError, setZoneError] = useState(false);
  // Re-seed when the PROP changes identity from the initial render, which on
  // this path means exactly one thing: the first prefs read resolved. `usePrefs`
  // answers `DEFAULT_PREFS` until then, so a reader who reaches Settings then
  // Editor faster than a local blob decrypt saw an empty field over a set zone,
  // and blurring it committed the emptiness (myne-md/myne#609, found in review).
  // Keyed on the prop rather than on a loading flag so it stays correct if a
  // second writer ever appears; `commitZone` sets the text itself, so the echo
  // it writes equals the prop and this is a no-op on that path.
  const seeded = useRef(timezone);
  if (seeded.current !== timezone) {
    seeded.current = timezone;
    setZoneText(timezone);
  }

  const commitZone = (): void => {
    const next = zoneText.trim();
    // Refuse a zone this runtime cannot format in, rather than storing a value
    // that silently reads as "unset" forever. Clearing the field is always
    // allowed: empty IS "follow this device".
    if (next !== "" && !isSupportedTimeZone(next)) {
      setZoneError(true);
      // Put the LAST STORED value back on screen, rather than leaving a value
      // that was refused sitting in the field. Leaving it there is what the
      // first version did, and it produces the worst of both readings: the row
      // shows a zone, the vault holds a different one, and dismissing the sheet
      // makes the wrong one look settled. The error line above says what was
      // refused; the field says what is in effect.
      setZoneText(timezone);
      return;
    }
    setZoneError(false);
    // Echo the trimmed value back into the field, so what is on screen is what
    // was stored. This is the assignment the removed mirroring effect was doing
    // by accident, made explicit and local to the one thing that causes it.
    setZoneText(next);
    // The field holds its own text, so a rejected write has to put the stored
    // value back here as well as in the draft.
    onZone(next === "" ? null : next, () => setZoneText(timezone));
  };

  // Typing clears the error, rather than only a successful commit doing it.
  // Otherwise the red line and the refused-zone message stay under the field
  // while the reader is midway through correcting exactly the thing it is
  // complaining about.
  const editZone = (v: string): void => {
    setZoneText(v);
    if (zoneError) setZoneError(false);
  };

  const dateLabels = (DATE_FORMATS as readonly DateFormat[]).map((value) =>
    value === "system"
      ? t("settings.dateTime.dateSystem")
      : formatCivilDate(SAMPLE_DATE, { ...display, dateFormat: value }),
  );
  const timeLabels = (TIME_FORMATS as readonly TimeFormat[]).map((value) =>
    value === "system"
      ? t("settings.dateTime.timeSystem")
      : t(value === "24h" ? "settings.dateTime.time24" : "settings.dateTime.time12"),
  );

  return (
    <>
      <SelectBlock
        label={t("settings.dateTime.dateLabel")}
        options={DATE_FORMATS}
        labels={dateLabels}
        value={dateFormat}
        onPick={(v) => onDate(v === "system" ? null : v)}
        testId="settings.dateTime.date-select"
      />
      <SegmentBlock
        label={t("settings.dateTime.timeLabel")}
        options={TIME_FORMATS}
        labels={timeLabels}
        value={timeFormat}
        onPick={(v) => onTime(v === "system" ? null : v)}
        testId="settings.dateTime.time-segmented"
      />
      <div style={CARD_STYLE}>
        <div style={BLOCK_LABEL_STYLE}>{t("settings.dateTime.zoneLabel")}</div>
        <SheetInput
          value={zoneText}
          onChange={editZone}
          onBlur={commitZone}
          // Enter commits too, not blur alone. On Android the hardware back
          // button dismisses this sheet without ever blurring the field, so a
          // blur-only commit silently discarded a zone the reader had typed and
          // considered entered. The desktop twin commits on both.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitZone();
            }
          }}
          testId="settings.dateTime.zone-input"
          // The label is a sibling div with no `for`, so without this the field
          // has no accessible name at all. Its desktop twin sets one; the two
          // sibling rows in this same block do too, which made the zone row the
          // odd one out inside its own block.
          ariaLabel={t("settings.dateTime.zoneLabel")}
          describedBy={ZONE_HELP_ID}
          placeholder={t("settings.dateTime.zonePlaceholder")}
        />
        <div
          id={ZONE_HELP_ID}
          // `alert` while it is a refusal, `status` while it is a helper. Colour
          // alone is not a state signal, and the refusal also restores the field
          // to the stored value, so without this a non-sighted user gets no
          // indication that what they typed was rejected.
          role={zoneError ? "alert" : "status"}
          style={{
            fontSize: "var(--text-sm)",
            marginTop: "var(--space-2)",
            color: zoneError ? "var(--danger)" : "var(--fg-2)",
          }}
        >
          {zoneError ? t("settings.dateTime.zoneUnknown") : t("settings.dateTime.zoneHelper")}
        </div>
      </div>
    </>
  );
}

/** Settings → Appearance display-language selector. Like Theme, this is a
 *  device-local UI preference persisted to localStorage (`myne.lang`), NOT the
 *  encrypted `vault.prefs` blob — the language must be selectable pre-unlock
 *  (Welcome / Unlock render pre-vault). `setLanguage` writes localStorage +
 *  `i18n.changeLanguage`, which re-renders every `useTranslation` subscriber
 *  (this sheet + the editor behind it) without a reload. Shares desktop's
 *  `SUPPORTED_LANGUAGES` + `settings.language.*` keys (MYND-485). */
function LanguageBlock() {
  const { t, i18n } = useTranslation();
  // `resolvedLanguage` is the active locale after fallback (`tr-TR` → `tr`);
  // guard an unsupported value so the <select> always has a matching <option>.
  const active = i18n.resolvedLanguage ?? i18n.language;
  const value = SUPPORTED_CODES.includes(active) ? active : "en";
  return (
    <SelectBlock
      label={t("settings.language.label")}
      options={SUPPORTED_CODES as readonly LanguageCode[]}
      labels={SUPPORTED_CODES.map(
        (code) => SUPPORTED_LANGUAGES.find((l) => l.code === code)?.label ?? code,
      )}
      value={value as LanguageCode}
      onPick={setLanguage}
      helper={t("settings.language.helper")}
      testId="settings.language-select"
    />
  );
}

/** Settings → Appearance → Custom themes (MYND-598). Read-only: palettes are
 *  vault content authored on a computer, so a row is an apply control and
 *  nothing more — there is no import/export/delete affordance to render.
 *
 *  Rendered ALWAYS, including with an empty list. The helper line is the only
 *  place in the product that states the read-only scope to the user, and hiding
 *  the block on an empty list would turn "you have installed none" into "sync
 *  looks broken". */
function CustomThemesBlock({
  entries,
  selected,
  onPick,
}: {
  entries: readonly CustomThemeEntry[];
  selected: string | null | undefined;
  onPick: (entry: CustomThemeEntry) => void;
}) {
  const { t } = useTranslation();
  return (
    <div data-testid="settings.custom-themes" style={CARD_STYLE}>
      <div style={rowLabel}>{t("settings.customThemes.label")}</div>
      <div style={{ marginTop: 6, fontSize: 12, color: "var(--fg-3)", lineHeight: 1.4 }}>
        {t("settings.customThemes.readOnlyHelper")}
      </div>
      {entries.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
          {entries.map((entry) => {
            const on = selected === entry.name;
            return (
              <div
                key={entry.name}
                data-testid="settings.custom-theme-row"
                data-theme-name={entry.name}
                data-selected={on ? "true" : "false"}
                // The row IS the apply control — a tap applies the theme,
                // matching every other tappable row in this sheet. Since
                // myne#728 task 16 that means a real one: `tappable` gives it
                // the role, the Tab stop and the Enter/Space handling a
                // screen reader and an external keyboard need, and `pressed`
                // is what says WHICH theme is the applied one (`aria-selected`
                // is not valid on a button).
                {...tappable({ onActivate: () => onPick(entry), pressed: on })}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  minHeight: 44,
                  padding: "8px 10px",
                  borderRadius: 8,
                  cursor: "pointer",
                  background: on ? "var(--accent-soft)" : "var(--bg-2)",
                  border: on ? "1px solid var(--accent)" : "1px solid var(--line-1)",
                }}
              >
                <ThemeChiplet palette={entry.palette} testId="settings.custom-theme-swatch" />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 15,
                    color: "var(--fg-1)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {entry.name}
                </span>
                {on && (
                  <span style={{ flex: "none", fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
                    {t("settings.customThemes.appliedBadge")}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A settings toggle row (title + optional subtitle + iOS switch). */
function ToggleRow({
  title,
  subtitle,
  on,
  onToggle,
  first = false,
  testId,
}: {
  title: string;
  subtitle?: string;
  on: boolean;
  onToggle: () => void;
  first?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "11px 14px",
        borderTop: first ? undefined : "1px solid var(--line-1)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 16, color: "var(--fg-1)" }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2, lineHeight: 1.4 }}>{subtitle}</div>}
      </div>
      <Switch on={on} onToggle={onToggle} />
    </div>
  );
}

// ── Root category list (Obsidian-style drill-down) ───────────────────────────

/** Monochrome 20px line glyphs for the root category rows. `currentColor` so
 *  they inherit the row's muted icon tint. */
const CAT_GLYPH: Record<string, ReactNode> = {
  sync: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 8a8 8 0 0 0-14.5-3M4 5v4h4" />
      <path d="M4 16a8 8 0 0 0 14.5 3M20 19v-4h-4" />
    </svg>
  ),
  account: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.5 19c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5" />
    </svg>
  ),
  appearance: (
    <svg width="20" height="20" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 4a8 8 0 010 16z" fill="currentColor" />
    </svg>
  ),
  editor: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20l1-4L15.5 5.5a1.8 1.8 0 012.5 0l.5.5a1.8 1.8 0 010 2.5L8 19l-4 1z" />
      <path d="M13.5 7.5l3 3" />
    </svg>
  ),
  privacy: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V8a4 4 0 018 0v2.5" />
    </svg>
  ),
  data: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v9" />
      <path d="M8.5 9.5L12 13l3.5-3.5" />
      <path d="M5 15v3a1.5 1.5 0 001.5 1.5h11a1.5 1.5 0 001.5-1.5v-3" />
    </svg>
  ),
  ai: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4.5l1.7 4.3 4.3 1.7-4.3 1.7L12 16.5l-1.7-4.3L6 10.5l4.3-1.7z" />
      <path d="M17.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </svg>
  ),
  about: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 11.5v4.5" />
      <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  ),
};

/** A helper line under a settings group, in the sheet's own geometry.
 *
 *  The geometry is hoisted into {@link HINT_STYLE} rather than written inline,
 *  which is not tidiness: `scripts/check-token-adoption.mjs` counts hardcoded
 *  visual values PER FILE and the count may shrink, never grow. Two inline
 *  copies of these same numbers already existed here before this component; one
 *  constant is what they should have been, and it is what lets a third helper
 *  line cost nothing.
 */
function PanelHint({ children }: { children: ReactNode }) {
  return <div style={HINT_STYLE}>{children}</div>;
}

/** The two providers this build can reach, as proper nouns.
 *
 *  From `@myne/copy` rather than from i18n: a brand name reads identically in
 *  every locale, and a translated one is a wrong one. Resolved once here so the
 *  render sites read as labels rather than as calls.
 */
const PROVIDER_OPENROUTER = providerLabelOf("openrouter") ?? "OpenRouter";
const PROVIDER_OLLAMA_CLOUD = providerLabelOf("ollama-cloud") ?? "Ollama Cloud";

/** What the root row says about AI without opening the panel.
 *
 *  Deliberately the CURRENT STATE rather than a badge. "Off" is the shipped
 *  default and the honest thing to show, and once a provider is named, naming it
 *  here tells the user where their notes would go without a drill-down. Same
 *  reasoning the sync row's summary follows.
 */
function aiSummary(prefs: PrefsView, t: TFunction): string {
  if (!prefs.ai_enabled) return t("settings.archive.off");
  const provider = prefs.ai_provider;
  if (provider === null) return t("settings.ai.providerNone");
  // A stored provider this build does not know reads as "None", not as its raw
  // wire value: the host treats it as no provider rather than guessing, and a
  // summary that named it would describe a selection the request path ignores.
  if (provider !== "openrouter" && provider !== "ollama-cloud") {
    return t("settings.ai.providerNone");
  }
  return providerLabelOf(provider) ?? t("settings.ai.providerNone");
}

/**
 * AI settings: the device opt-in, the provider, its key, and its model.
 *
 * **Discovery, not enforcement.** Every control here writes a preference, and
 * the host re-reads all of them at request time through its own gate
 * (`provider_gate.rs`). A panel that hid a control would not stop a request, and
 * a panel that showed one does not authorise it. That split is why this can be
 * read as ordinary UI.
 *
 * **The key is write-only.** There is no getter for it anywhere: the host marks
 * the field serde-skip so it never reaches page context, and this panel decides
 * between "Add key" and "Replace key" from the boolean `aiProviderHasKey`
 * returns. The draft is cleared the moment it is submitted.
 *
 * **The consent screen is not here.** Naming a provider and pasting a key are
 * configuration; agreeing to send note text to a named recipient is a decision,
 * and it gets its own screen. Putting an approval control in a settings list is
 * how consent becomes a checkbox nobody reads.
 */
function AiPanel({
  prefs,
  hasKey,
  models,
  modelsState,
  onEnabled,
  onProvider,
  onKey,
  onModel,
  onLoadModels,
  onRevoke,
  onToast,
}: {
  prefs: PrefsView;
  hasKey: boolean;
  models: string[];
  modelsState: "idle" | "loading" | "failed";
  onEnabled: (on: boolean) => void;
  onProvider: (wire: string | null) => void;
  onKey: (key: string) => void;
  onModel: (model: string) => void;
  onLoadModels: () => void;
  onRevoke: () => void;
  onToast: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [keyDraft, setKeyDraft] = useState("");
  const provider = prefs.ai_provider;

  return (
    <div style={PANEL_STACK}>
      <Group>
        <ToggleRow
          first
          title={t("settings.ai.mobileEnableLabel")}
          subtitle={t("settings.ai.mobileEnableHelper")}
          on={prefs.ai_enabled}
          onToggle={() => onEnabled(!prefs.ai_enabled)}
          testId="settings.ai-enabled"
        />
      </Group>

      {/* Everything below is meaningless with the switch off, and rendering it
          disabled would be an offer this device will not honour. Omitted rather
          than greyed, which is the call `decisions.md` 2026-07-26 makes
          normative for a capability a platform lacks. */}
      {prefs.ai_enabled && (
        <>
          <SectionLabel>{t("settings.ai.providerLabel")}</SectionLabel>
          <Group>
            <ToggleRow
              first
              title={PROVIDER_OPENROUTER}
              on={provider === "openrouter"}
              onToggle={() => onProvider(provider === "openrouter" ? null : "openrouter")}
              testId="settings.ai-provider-openrouter"
            />
            <ToggleRow
              title={PROVIDER_OLLAMA_CLOUD}
              on={provider === "ollama-cloud"}
              onToggle={() => onProvider(provider === "ollama-cloud" ? null : "ollama-cloud")}
              testId="settings.ai-provider-ollama-cloud"
            />
          </Group>
          <PanelHint>{t("settings.ai.providerHelper")}</PanelHint>

          {provider !== null && (
            <>
              <SectionLabel>{t("settings.ai.providerKeyLabel")}</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <SheetInput
                  type="password"
                  mono
                  value={keyDraft}
                  onChange={setKeyDraft}
                  placeholder={
                    hasKey
                      ? t("settings.ai.providerKeyReplace")
                      : t("settings.ai.providerKeyAdd")
                  }
                />
                <div data-testid="settings.ai-key-save">
                  <Button
                    disabled={keyDraft.trim() === ""}
                    onClick={() => {
                      onKey(keyDraft.trim());
                      // Cleared immediately: the draft is the only copy of the
                      // key in page context, and it has served its purpose the
                      // moment the write is dispatched.
                      setKeyDraft("");
                    }}
                  >
                    {hasKey ? t("settings.ai.mobileKeyReplace") : t("settings.ai.mobileKeyAdd")}
                  </Button>
                </div>
              </div>
              <PanelHint>{hasKey ? t("settings.ai.providerKeyStored") : t("settings.ai.providerKeyNone")}</PanelHint>

              {hasKey && (
                <>
                  <SectionLabel>{t("settings.ai.providerModelLabel")}</SectionLabel>
                  {modelsState === "loading" && (
                    <Group>
                      <Row first>
                        <span style={rowLabel}>{t("settings.ai.providerModelLoad")}</span>
                        <Spinner size={18} />
                      </Row>
                    </Group>
                  )}
                  {modelsState === "failed" && (
                    <Group>
                      <Row first onClick={onLoadModels} testId="settings.ai-models-retry">
                        <span style={rowLabel}>{t("settings.ai.providerError.failed")}</span>
                        <RowChevron />
                      </Row>
                    </Group>
                  )}
                  {modelsState === "idle" && models.length === 0 && (
                    <Group>
                      <Row first onClick={onLoadModels} testId="settings.ai-models-load">
                        <span style={rowLabel}>{t("settings.ai.providerModelLoad")}</span>
                        <RowChevron />
                      </Row>
                    </Group>
                  )}
                  {modelsState === "idle" && models.length > 0 && (
                    <Group>
                      {models.map((m, i) => (
                        <ToggleRow
                          key={m}
                          first={i === 0}
                          title={m}
                          on={prefs.ai_provider_model === m}
                          onToggle={() => onModel(m)}
                        />
                      ))}
                    </Group>
                  )}
                  {/* Stated whether or not a model is chosen, because "no model
                      chosen" is a REFUSAL state rather than a neutral one: the
                      host ships no fallback, so an unchosen model means every
                      request is turned away. */}
                  <PanelHint>
                    {prefs.ai_provider_model === null
                      ? t("settings.ai.providerModelUnfetched")
                      : t("settings.ai.providerModelHelper")}
                  </PanelHint>
                </>
              )}

              {/* **The approval this device has not given.** Shown when a
                  provider is selected and the stored consent does not NAME it,
                  which is the ordinary state of a phone enrolled into a vault
                  someone configured on a laptop: `ai_provider_consent` is
                  device-local (myne-md/myne#456) while the provider, the model
                  and the key all sync.

                  It exists because without it the panel is actively
                  misleading. The provider row reads as ON, every field below it
                  is filled in, and the one thing missing is invisible: the only
                  route to the consent screen was to toggle the provider off and
                  on, which nobody would think to do and which reads as breaking
                  a working setup. */}
              {/* `consentIsDeviceScoped`, not an equality against the provider
                  name. A legacy bare-name value is what a device enrolled before
                  the reclassification holds, and an equality would read it as
                  current and hide this row, leaving the phone silently sending
                  under an approval nobody at this device gave
                  (myne-md/myne#456). */}
              {!consentIsDeviceScoped(prefs.ai_provider_consent, provider) && (
                <>
                  <SectionLabel>{t("settings.ai.mobileApproveLabel")}</SectionLabel>
                  <Group>
                    <Row
                      first
                      onClick={() => onProvider(provider)}
                      testId="settings.ai-approve-here"
                    >
                      <span style={rowLabel}>{t("settings.ai.mobileApproveLabel")}</span>
                      <RowChevron />
                    </Row>
                  </Group>
                  <PanelHint>{t("settings.ai.mobileApproveHelper")}</PanelHint>
                </>
              )}

              <SectionLabel>{t("settings.ai.providerKeyLabel")}</SectionLabel>
              <Group>
                <Row first onClick={onRevoke} testId="settings.ai-revoke">
                  <span style={{ ...rowLabel, color: "var(--danger)" }}>
                    {t("settings.ai.providerKeyRevoke")}
                  </span>
                  <RowChevron />
                </Row>
              </Group>
              {/* The exact promise the host keeps: clearing the provider clears
                  the key and the consent with it, so "turn this off" leaves the
                  state of never having turned it on. */}
              <PanelHint>{t("settings.ai.mobileRevokeHelper")}</PanelHint>
            </>
          )}

          {/* Agent memory + personality (myne-md/myne#697): the desktop
              MemorySection twin. Gated on the opt-in only. Memory is
              written by local runs too, so hiding it behind a provider
              selection would make an enabled device's memory invisible. */}
          <MemorySection onToast={onToast} />
        </>
      )}
    </div>
  );
}

/** A root drill-down row: leading glyph, label, optional trailing value, chevron. */
function CategoryRow({
  glyph,
  label,
  value,
  first = false,
  testId,
  onClick,
}: {
  glyph: string;
  label: string;
  value?: string;
  first?: boolean;
  /** Optional, and only where a scenario has to reach the panel behind this
   *  row. Without one a spec matches the translated LABEL, which passes in
   *  English and fails in every other locale as though the feature were
   *  broken. */
  testId?: string;
  onClick: () => void;
}) {
  return (
    <Row first={first} testId={testId} onClick={onClick}>
      <span style={{ display: "flex", alignItems: "center", gap: 13, minWidth: 0 }}>
        <span style={{ display: "flex", color: "var(--fg-2)", flex: "none" }}>{CAT_GLYPH[glyph]}</span>
        <span style={rowLabel}>{label}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        {value && (
          <span style={{ fontSize: 15, color: "var(--fg-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {value}
          </span>
        )}
        <RowChevron />
      </span>
    </Row>
  );
}

// ── SettingsSheet ─────────────────────────────────────────────────────────────

export type Panel =
  | "root"
  // category detail panels
  | "account"
  | "appearance"
  | "editor"
  | "privacy"
  | "data"
  // Remote AI providers and the agent (myne-md/myne#456). A TOP-LEVEL panel,
  // peer to the categories above rather than nested under Privacy: the feature
  // has its own tab in the bottom bar, and burying its configuration under
  // another category would say the opposite of what that tab says.
  | "ai"
  | "about"
  // deeper action panels (nested under a category)
  | "change-password"
  | "delete-vault"
  | "rename"
  | "quick-unlock"
  // MYND-555: editor format-bar customization (device-local layout).
  | "format-bar"
  // Phase-2 sync (MYND-459): the sync settings panel + its sub-screens.
  | "sync"
  | "sync-endpoint"
  | "sync-enroll"
  | "sync-approve"
  | "sync-devices"
  | "sync-members";

/**
 * Format-bar layout editor (MYND-555) — reorder + show/hide the editor's
 * above-keyboard format actions.
 *
 * Reorder is move-up / move-down buttons, NOT drag-and-drop: the row already owns
 * the horizontal-scroll gesture on the bar itself, and a long-press-drag inside a
 * modal sheet on a phone fights the sheet's own dismiss gesture. Two explicit
 * buttons are also the accessible affordance, and they are what desktop's panel
 * offers (`settings.toolbarCustomize.moveUp` / `moveDown` already exist).
 *
 * Both writes send the WHOLE list — the setters are whole-value, and the resolver
 * is total, so a partial write is never a valid intermediate state. `order` is
 * always written as the fully-resolved 12-id list rather than a sparse diff, so a
 * later vocabulary addition appends predictably instead of interleaving.
 */
function FormatBarPanel({
  order,
  hidden,
  onOrder,
  onHidden,
}: {
  order: string[];
  hidden: string[];
  onOrder: (next: string[]) => void;
  onHidden: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const resolved = resolveFormatBarOrder(order);
  const hiddenSet = new Set(hidden);

  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= resolved.length) return;
    const next = [...resolved];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onOrder(next);
  };
  const toggle = (id: string) => {
    const next = hiddenSet.has(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
    // Sorted so the optimistic draft matches what the codec canonicalizes on
    // disk — otherwise the panel would re-render in a different order than the
    // next `prefs_read` returns.
    onHidden([...next].sort());
  };

  const labelFor = (id: string): string => {
    const key = formatBarLabelKey(id);
    return key ? t(key) : id;
  };

  return (
    <div style={PANEL_STACK}>
      <Group>
        {resolved.map((id, i) => {
          const isHidden = hiddenSet.has(id);
          return (
            <Row key={id} first={i === 0} testId={`settings.format-bar-item-${id}`}>
              <span
                style={{
                  ...rowLabel,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  // A hidden action stays listed (that is how you bring it back)
                  // but reads as inactive.
                  color: isHidden ? "var(--fg-3)" : "var(--fg-1)",
                }}
              >
                {labelFor(id)}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}>
                <IconBtn
                  label={t("settings.toolbarCustomize.moveUp")}
                  disabled={i === 0}
                  testId={`settings.format-bar-up-${id}`}
                  onClick={() => move(i, -1)}
                >
                  <path d="M3 8l5-5 5 5" />
                </IconBtn>
                <IconBtn
                  label={t("settings.toolbarCustomize.moveDown")}
                  disabled={i === resolved.length - 1}
                  testId={`settings.format-bar-down-${id}`}
                  onClick={() => move(i, 1)}
                >
                  <path d="M3 5l5 5 5-5" />
                </IconBtn>
                {/* `Switch` takes no testId, so the hook hangs on a wrapper —
                    a click at its center lands on the switch itself. */}
                <span data-testid={`settings.format-bar-toggle-${id}`} style={{ display: "flex", flex: "none" }}>
                  <Switch on={!isHidden} onToggle={() => toggle(id)} />
                </span>
              </span>
            </Row>
          );
        })}
      </Group>
    </div>
  );
}

/** Small square icon button used by {@link FormatBarPanel}'s reorder controls. */
function IconBtn({
  label,
  disabled,
  onClick,
  testId,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      style={{
        width: 32,
        height: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--line-1)",
        borderRadius: 8,
        background: "transparent",
        color: disabled ? "var(--line-2)" : "var(--fg-2)",
        cursor: disabled ? "default" : "pointer",
        flex: "none",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

/** Parent panel for the header back button (one level up the stack). */
const PANEL_PARENT: Record<Panel, Panel> = {
  root: "root",
  account: "root",
  appearance: "root",
  editor: "root",
  privacy: "root",
  data: "root",
  ai: "root",
  about: "root",
  rename: "account",
  "change-password": "account",
  "quick-unlock": "privacy",
  "format-bar": "editor",
  "delete-vault": "root",
  sync: "root",
  "sync-endpoint": "sync",
  "sync-enroll": "sync",
  "sync-approve": "sync-devices",
  "sync-devices": "sync",
  "sync-members": "sync",
};

/** Stack depth per panel — drives the slide direction of the panel transition
 *  (deeper → slide in from the right; shallower → slide in from the left). */
const PANEL_DEPTH: Record<Panel, number> = {
  root: 0,
  account: 1,
  appearance: 1,
  editor: 1,
  privacy: 1,
  data: 1,
  ai: 1,
  about: 1,
  rename: 2,
  "change-password": 2,
  "quick-unlock": 2,
  "format-bar": 2,
  "delete-vault": 2,
  sync: 1,
  "sync-endpoint": 2,
  "sync-enroll": 2,
  "sync-devices": 2,
  "sync-members": 2,
  "sync-approve": 3,
};

/** i18n key per panel for the sheet header title (resolved with `t()` at the
 *  render site — never call `t()` at module scope). */
const PANEL_TITLE: Record<Panel, string> = {
  root: "settings.shell.title",
  account: "settings.shell.panels.account",
  appearance: "settings.shell.panels.appearance",
  editor: "settings.shell.panels.editor",
  privacy: "settings.panelTitle.privacy",
  data: "settings.panelTitle.data",
  ai: "settings.shell.panels.ai",
  about: "settings.shell.panels.about",
  rename: "settings.panelTitle.vaultName",
  "change-password": "settings.changePassword.title",
  "quick-unlock": "settings.quickUnlock.title",
  "format-bar": "settings.toolbarCustomize.label",
  "delete-vault": "settings.deleteVault.heading",
  sync: "settings.shell.panels.sync",
  "sync-endpoint": "sync.join.serverLabel",
  "sync-enroll": "sync.enroll.submit",
  "sync-devices": "sync.devices.yourDevices",
  "sync-members": "sync.members.title",
  "sync-approve": "settings.panelTitle.approveDevice",
};

/** Short, glanceable sync summary for the Settings row value (no wall-clock — SYNC-48).
 *  `t` is passed in from the render site so this stays free of module-scope `t()`. */
function syncSummary(status: SyncStatus | null, t: TFunction): string {
  switch (status?.state) {
    case "disabled":
    case undefined:
      return t("settings.archive.off");
    case "not_enrolled":
      return t("settings.sync.summary.notSetUp");
    case "pending":
      return t("sync.status.awaitingApproval");
    case "idle":
      return t("settings.archive.on");
    case "syncing":
      return t("sync.status.syncing");
    case "error":
      return t("settings.sync.summary.offline");
    case "conflicts":
      return t("settings.sync.summary.conflicts", { count: status.count });
  }
}

export interface SettingsSheetProps {
  vaultId?: VaultId;
  onClose: () => void;
  onLock: () => void;
  onDeleteVaultSuccess: () => void;
  /** Panel to open on mount. Defaults to `root`. The first-run AI onboarding
   *  opens `ai` directly (myne-md/myne#805). */
  initialPanel?: Panel;
}

function strengthLevel(len: number): "Weak" | "Fair" | "Good" | "Strong" {
  if (len < 12) return "Weak";
  if (len < 16) return "Fair";
  if (len < 20) return "Good";
  return "Strong";
}

export function SettingsSheet({ vaultId, onClose, onLock, onDeleteVaultSuccess, initialPanel }: SettingsSheetProps) {
  const { t, i18n } = useTranslation();
  const { biometric, isAndroid } = usePlatform();
  const [panel, setPanel] = useState<Panel>(initialPanel ?? "root");
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredChoice());
  const [toast, setToast] = useState<string | null>(null);
  // Phase-2 sync (MYND-459): honest enrollment status for the Sync section, plus
  // the force-sync trigger surfaced there now that the general-UI glyph is gone
  // (MYND-481).
  const { status: syncStatus, syncNow, busy: syncBusy } = useSyncStatus();

  // Change-password local secret state (wiped on every exit path + unmount).
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

  // Delete-vault confirm state (not secret).
  const [confirmText, setConfirmText] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Quick-unlock (PIN + biometric) state. `quStatus` reflects disk truth for
  // the active vault; the PIN fields are local secrets wiped on every exit path.
  const [quStatus, setQuStatus] = useState<QuickUnlockStatus | null>(null);
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);

  // Vault → Markdown export (writes a plaintext tree to the app Documents dir).
  const [exporting, setExporting] = useState(false);

  async function runExport() {
    if (exporting) return;
    setExporting(true);
    try {
      if (HAS_TAURI) {
        const dest = await defaultExportDestination();
        const summary = await vaultExportMarkdown(dest.path);
        setToast(t("settings.data.exported", { count: summary.notes, label: dest.label }));
        // Offer the native destination chooser for the exported folder (MYND-475);
        // additive on top of the guaranteed Documents write above.
        await shareFile(dest.path);
      } else {
        setToast(t("settings.data.exportNeedsApp"));
      }
    } catch {
      setToast(t("settings.data.exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  const refreshQuStatus = useCallback(() => {
    if (!HAS_TAURI) return;
    void quickUnlockStatus()
      .then(setQuStatus)
      .catch(() => setQuStatus(null));
  }, []);
  useEffect(() => refreshQuStatus(), [refreshQuStatus]);

  // ── Custom themes (read-only consumer of vault.themes, MYND-598) ───────────
  // Palettes are VAULT CONTENT that sync already delivers here; the phone lists
  // and applies them but never authors one, so there is no import/export/delete
  // affordance to build. Read ONCE per sheet, the first time the Appearance
  // panel opens — deliberately NOT live-refreshed from the sync-changed event
  // this app already listens to: the panel is a seconds-long visit, and
  // re-reading mid-visit would let rows shift (or the selected row vanish) under
  // the user's finger for no benefit. The `loaded` latch is what makes drilling
  // back into Appearance a second time free rather than another whole
  // `vault.themes` decrypt; closing the sheet unmounts it, so a later visit is
  // still fresh.
  const [customThemes, setCustomThemes] = useState<CustomThemeEntry[]>([]);
  const themesLoaded = useRef(false);
  useEffect(() => {
    if (panel !== "appearance" || !HAS_TAURI || themesLoaded.current) return;
    themesLoaded.current = true;
    let cancelled = false;
    let settled = false;
    void listCustomThemes()
      .then((entries) => {
        settled = true;
        if (cancelled) return;
        // The host hands these back in `BTreeMap` order — UTF-8 byte order, which
        // sorts "Şafak" after "Zed". Theme names are user-authored, so collate in
        // the reader's locale rather than the store's byte order (desktop's
        // `CustomThemesSection` does the same, for the same reason).
        setCustomThemes([...entries].sort((a, b) => a.name.localeCompare(b.name)));
      })
      // A cosmetic palette is not load-bearing: the host already collapses every
      // recoverable read failure to the empty store (§ 9.21.4), so the only way
      // here is a locked slot — which this panel cannot be open under. Render the
      // block empty rather than an error the user has no action to take about.
      .catch(() => {
        settled = true;
        if (!cancelled) setCustomThemes([]);
      });
    return () => {
      cancelled = true;
      // Left the panel before the read landed: unlatch, so coming back retries
      // rather than showing an empty block for the rest of the sheet's life.
      if (!settled) themesLoaded.current = false;
    };
  }, [panel]);

  // ── Vault prefs (Appearance / Editor / Privacy) ────────────────────────────
  const { prefs } = usePrefs();
  // Home quick-action tile visibility toggles (MYND-479, Appearance panel).
  const hiddenHomeTiles = useHiddenHomeTiles();
  const [draft, setDraft] = useState<Partial<PrefsView>>({});
  const eff: PrefsView = { ...prefs, ...draft };

  // ---- AI (myne-md/myne#456) ------------------------------------------------
  //
  // `aiHasKey` is a boolean rather than the key, and that is the whole shape:
  // the host marks the key serde-skip so it never reaches page context, and the
  // panel decides between "Add key" and "Replace key" from this.
  const [aiHasKey, setAiHasKey] = useState(false);
  // **Which provider is awaiting this device's approval.** Non-null puts the
  // consent screen on top of the panel, and the only writer of
  // `ai_provider_consent` is that screen's accept path: so there is no route
  // to a recorded consent that skips the disclosure.
  const [aiConsentFor, setAiConsentFor] = useState<string | null>(null);
  const [aiModels, setAiModels] = useState<string[]>([]);
  const [aiModelsState, setAiModelsState] = useState<"idle" | "loading" | "failed">("idle");

  // Re-read whenever the panel is opened, and whenever the provider changes.
  // NOT on mount: this is one IPC call and the panel is a seconds-long visit,
  // so reading it for every settings session that never goes near AI is work
  // nobody asked for.
  useEffect(() => {
    if (panel !== "ai" || !HAS_TAURI) return;
    let live = true;
    void aiProviderHasKey()
      .then((has) => {
        if (live) setAiHasKey(has);
      })
      .catch(() => {
        // Fail to "no key", which is the safe direction: it offers "Add key"
        // rather than "Replace key", so the user is never told a credential is
        // stored when the host could not confirm one.
        if (live) setAiHasKey(false);
      });
    return () => {
      live = false;
    };
  }, [panel, eff.ai_provider]);

  /** Ask the provider what it publishes. Opens a socket, so it is a user act. */
  function loadAiModels() {
    if (!HAS_TAURI) return;
    setAiModelsState("loading");
    void listProviderModels()
      .then((list) => {
        setAiModels(list.map((m) => m.id));
        setAiModelsState("idle");
      })
      .catch(() => {
        // Reported as a retryable state rather than a toast: the chooser is
        // where the user is looking, and a failed listing is a thing to try
        // again rather than a thing that went wrong elsewhere.
        setAiModels([]);
        setAiModelsState("failed");
      });
  }

  /** Clear the provider, which clears the key and the consent with it. */
  function revokeAiProvider() {
    setAiModels([]);
    setAiModelsState("idle");
    setAiHasKey(false);
    writeDraftPref("ai_provider", null, () => setAiProvider(null));
  }

  const [renameText, setRenameText] = useState("");

  /** Optimistic prefs setter: reflect instantly, persist, revert the one key on
   *  failure. Deliberately NOT named `writePref`: that is the IPC chokepoint in
   *  `lib/prefs.ts`, which is what bumps the shared prefs nonce so EVERY
   *  `usePrefs` consumer (this sheet + the live editor behind it) re-reads disk
   *  truth. This wrapper adds only the optimistic draft and its revert; the
   *  failure path needs no bump because the draft key is dropped, leaving `eff`
   *  back on the unchanged `prefs`. In browser-dev (no Tauri host) the draft-only
   *  path keeps the UI interactive. */
  /**
   * @param onFailed run when the write is REJECTED, after the draft has been
   *   rolled back. Optional, because most rows render straight off `eff` and the
   *   rollback is the whole repair. A row holding its own text state does not:
   *   the zone field kept the value that failed to store while the vault held
   *   the old one, which is the reading its own validation branch was written to
   *   prevent (myne-md/myne#609, found in review).
   */
  function writeDraftPref<K extends keyof PrefsView>(
    key: K,
    value: PrefsView[K],
    persist: () => Promise<void>,
    onFailed?: () => void,
  ) {
    setDraft((d) => ({ ...d, [key]: value }));
    if (!HAS_TAURI) return Promise.resolve();
    return persist().catch(() => {
      setDraft((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
      setToast(t("settings.saveSettingError"));
      onFailed?.();
    });
  }

  const wipeRef = useRef<() => void>(() => {});
  wipeRef.current = () => {
    setCurrentPw("");
    setNewPw("");
    setConfirmPw("");
    setPwError(null);
    setPin("");
    setPinConfirm("");
    setPinError(null);
  };

  // Best-effort secret wipe on unmount (V8 strings are immutable + not
  // zeroizable — the load-bearing zeroize is Rust-side; this drops references).
  useEffect(() => {
    return () => wipeRef.current();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Slide the panel content when drilling between drawer levels: deeper panels
  // enter from the right, going back enters from the left (iOS push/pop feel);
  // AND smoothly animate the sheet's HEIGHT between panels of different length
  // (FLIP: snap to the old height with no transition, reflow, then transition to
  // the new height) so the modal grows/shrinks instead of jumping.
  // `firstRender` skips the very first paint so it rides the Sheet's open anim.
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevDepthRef = useRef(PANEL_DEPTH.root);
  const firstRenderRef = useRef(true);
  const prevHeightRef = useRef<number | null>(null);
  const heightSettleRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const depth = PANEL_DEPTH[panel];
    const forward = depth >= prevDepthRef.current;
    prevDepthRef.current = depth;
    const el = scrollRef.current;
    if (!el) return;

    // Natural height of the new panel, capped so a long panel scrolls inside the
    // sheet rather than overflowing it (the sheet itself is maxHeight 88%).
    const cap = Math.round(window.innerHeight * 0.8);
    const target = Math.min(el.scrollHeight, cap);

    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      prevHeightRef.current = target;
      return; // first paint keeps height:auto so it rides the Sheet open anim
    }

    const from = prevHeightRef.current ?? target;
    prevHeightRef.current = target;

    // FLIP the height.
    if (heightSettleRef.current !== null) window.clearTimeout(heightSettleRef.current);
    el.style.transition = "none";
    el.style.height = `${from}px`;
    void el.offsetHeight; // force reflow so the next height change transitions
    el.style.transition = "height 280ms cubic-bezier(0.22, 0.61, 0.36, 1)";
    el.style.height = `${target}px`;
    // Once settled, drop back to auto so intra-panel content changes aren't
    // clipped (a taller panel stays capped + scrolls, so leave it explicit).
    heightSettleRef.current = window.setTimeout(() => {
      if (scrollRef.current && target < cap) scrollRef.current.style.height = "auto";
    }, 300);

    // Slide the content in.
    if (typeof el.animate === "function") {
      el.scrollTop = 0; // each panel is its own screen — start at the top
      // Under RTL a "forward" (deeper) panel enters from the LEFT — flip the axis.
      const enter = (forward ? 22 : -22) * (isRtl() ? -1 : 1);
      el.animate(
        [
          { opacity: 0, transform: `translateX(${enter}px)` },
          { opacity: 1, transform: "translateX(0)" },
        ],
        { duration: 200, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)" },
      );
    }
  }, [panel]);

  /**
   * Apply a built-in appearance.
   *
   * A custom theme OVERRIDES the built-in choice, so picking a built-in one has
   * to revert the palette as well — otherwise this tap would appear to do
   * nothing, the custom vars still winning on every token they define.
   *
   * That revert is a VAULT write, so it goes disk-first, the same ordering
   * `pickCustomTheme` uses and for the same reason: what is on screen must
   * never contradict what `vault.prefs` names, or the next unlock paints back a
   * theme the user just turned off. A failed clear therefore changes nothing
   * and says so, rather than leaving the screen and the disk disagreeing.
   *
   * Only when there IS a selection to clear: an unconditional write would touch
   * vault.prefs on every theme tap for no change at all — and, since nothing is
   * awaited in that case, the common tap stays synchronous.
   */
  async function pickTheme(next: ThemeChoice) {
    if (HAS_TAURI && eff.custom_theme != null) {
      try {
        await setCustomTheme(null);
      } catch {
        setToast(t("settings.saveSettingError"));
        return;
      }
    }
    // #50: DISK FIRST, like the custom-theme write below and like desktop's
    // `AppearancePanel`. This used to paint the new theme, move the selection
    // and write `localStorage` and only THEN fire the `vault.prefs` write with
    // a swallowed rejection — so a failed write left the app looking themed
    // while `vault.prefs` (and therefore sync, backup and the next unlock)
    // still held the old value. The user had no way to know.
    if (HAS_TAURI) {
      try {
        await persistTheme(
          next === "system" ? null : (next as "light" | "dark" | "amoled"),
        );
      } catch {
        setToast(t("settings.saveSettingError"));
        return;
      }
    }
    setChoice(next);
    applyThemeChoice(next);
    clearCustomTheme();
    setDraft((d) => ({ ...d, custom_theme: null }));
    // The pre-unlock boot cache, written only once the vault write has landed
    // — the custom selection deliberately never joins it (see `pickCustomTheme`).
    if (typeof localStorage !== "undefined") localStorage.setItem(THEME_STORAGE_KEY, next);
  }

  /**
   * Apply a custom theme in one tap — no select-then-confirm step.
   *
   * Disk-first, exactly like desktop's `activateCustomTheme`: persist the
   * selection, THEN paint. A crash between the two leaves the vault consistent
   * and only the screen stale, never the reverse.
   *
   * The palette comes from the row's OWN list entry — `themes_list` already
   * decrypted every palette to answer the list, so buying one back with a second
   * read would be a whole extra decrypt for bytes we are holding. (`themes_read`
   * is not even registered on mobile, so it is not an option to reach for.)
   *
   * Neither the palette nor the theme name is written to `localStorage`. That
   * cache keeps the one job it has — the pre-unlock built-in light/dark boot
   * choice — because a plaintext copy of a vault-content palette on a locked
   * device is precisely what `design-notes.md` 2026-07-31 rules out.
   */
  async function pickCustomTheme(entry: CustomThemeEntry) {
    // Browser-dev has no host to persist to; it falls straight through to the
    // paint so the preview stays interactive.
    if (HAS_TAURI) {
      try {
        await setCustomTheme(entry.name);
      } catch {
        setToast(t("settings.customThemes.applyError"));
        return;
      }
    }
    applyCustomTheme(entry.palette);
    setDraft((d) => ({ ...d, custom_theme: entry.name }));
  }

  // Header back button: pop one level up the drawer stack (detail → category →
  // root), wiping any transient secret/confirm state on the way out.
  function goBack() {
    wipeRef.current();
    setConfirmText("");
    setDeleteError(null);
    setRenameText("");
    setPanel((p) => PANEL_PARENT[p]);
  }

  /** Persist the vault icon (vault-icons). `null` clears back to the wordmark.
   *  Goes through `writeDraftPref`, not the `submitRename` shape below it: it
   *  reflects optimistically and reverts THIS key with a toast on failure, which
   *  is why no in-flight/disabled state is needed. The success-path nonce bump
   *  that makes the header and sidebar marks re-read comes from `writePref`
   *  inside `lib/prefs.ts`, one layer down. Re-picking the active glyph is
   *  a no-op. An unrecognized stored name matches no cell and is left alone: the
   *  field is Shared(ScalarLww), so normalizing it here would clobber a newer
   *  client's choice on the next merge. */
  const selectIcon = (name: string | null) => {
    if (name === eff.icon) return;
    writeDraftPref("icon", name, () => setVaultIcon(name));
  };

  async function submitRename() {
    const label = renameText.trim();
    try {
      if (HAS_TAURI) await setVaultLabel(label.length > 0 ? label : null);
      setDraft((d) => ({ ...d, label: label.length > 0 ? label : null }));
      setToast(t("settings.account.renamedToast"));
      setPanel("account");
    } catch {
      setToast(t("settings.account.renameError"));
    }
  }

  async function submitSetupPin() {
    setPinError(null);
    if (pin.length < 6) {
      setPinError(t("settings.quickUnlock.pinTooShort"));
      return;
    }
    if (!/^\d+$/.test(pin)) {
      setPinError(t("settings.quickUnlock.errorPinNotDigits"));
      return;
    }
    if (pin !== pinConfirm) {
      setPinError(t("settings.quickUnlock.pinMismatch"));
      return;
    }
    setPinBusy(true);
    try {
      if (HAS_TAURI) await quickUnlockSetupPin(pin);
      setPin("");
      setPinConfirm("");
      refreshQuStatus();
      setToast(t("settings.quickUnlock.pinOnToast"));
      setPanel("privacy");
    } catch (e) {
      const kind = (e as { kind?: string })?.kind;
      setPinError(
        kind === "PinTooShort"
          ? t("settings.quickUnlock.pinTooShort")
          : kind === "PinNotDigits"
            ? t("settings.quickUnlock.errorPinNotDigits")
            : t("settings.quickUnlock.setupError"),
      );
    } finally {
      setPinBusy(false);
    }
  }

  async function disableQuickUnlock() {
    setPinBusy(true);
    try {
      if (HAS_TAURI) await quickUnlockDisable();
      refreshQuStatus();
      setToast(t("settings.quickUnlock.turnedOffToast"));
      setPanel("privacy");
    } catch {
      setToast(t("settings.quickUnlock.turnOffError"));
    } finally {
      setPinBusy(false);
    }
  }

  /** Enable Face ID / Touch ID quick-unlock (replaces a PIN credential — the
   *  device-local blob holds ONE method at a time). Setup only writes the
   *  biometry-gated Keychain item; the OS prompt fires on redeem, not here. */
  async function enableBiometric() {
    if (bioBusy) return;
    setPinError(null);
    setBioBusy(true);
    try {
      if (HAS_TAURI) await quickUnlockSetupBiometric();
      refreshQuStatus();
      setToast(t("settings.quickUnlock.biometricOnToast", { method: biometric }));
    } catch (e) {
      const kind = (e as { kind?: string })?.kind;
      setPinError(
        kind === "HardwareUnavailable"
          ? t("settings.quickUnlock.biometricUnavailable", { method: biometric })
          : kind === "BiometricAuthFailed"
            ? t("settings.quickUnlock.biometricAuthFailed", { method: biometric })
            : t("settings.quickUnlock.setupError"),
      );
    } finally {
      setBioBusy(false);
    }
  }

  /** Turn the biometric toggle off in place (stay on the panel — unlike the
   *  PIN "Turn off" button, a toggle flip shouldn't navigate away). */
  async function disableBiometric() {
    if (bioBusy) return;
    setPinError(null);
    setBioBusy(true);
    try {
      if (HAS_TAURI) await quickUnlockDisable();
      refreshQuStatus();
      setToast(t("settings.quickUnlock.turnedOffToast"));
    } catch {
      setToast(t("settings.quickUnlock.turnOffError"));
    } finally {
      setBioBusy(false);
    }
  }

  async function submitChangePassword() {
    setPwError(null);
    const cur = currentPw;
    const nw = newPw;
    const cf = confirmPw;
    if (nw.length < 12) {
      setPwError(t("settings.account.changePasswordError.weakNewPassword"));
      return;
    }
    if (nw !== cf) {
      setPwError(t("settings.account.newPasswordMismatch"));
      return;
    }
    if (nw === cur) {
      setPwError(t("settings.account.samePassword"));
      return;
    }
    setPwBusy(true);
    try {
      if (HAS_TAURI) await changePassword(cur, nw);
      wipeRef.current();
      setPwBusy(false);
      setToast(t("settings.account.passwordChangedToast"));
      setPanel("account");
    } catch (raw) {
      const e = raw as VaultChangePasswordError;
      switch (e.kind) {
        case "InvalidCredentialOrVault":
          // LITERAL compound (decisions.md 2026-05-02 + 2026-05-06): a single
          // non-distinguishing leg — never collapse to "wrong password" alone.
          // Load-bearing: kept inline, NOT routed through i18n.
          setPwError("Wrong current password or vault file is corrupted.");
          break;
        case "WeakNewPassword":
          setPwError(t("settings.account.changePasswordError.weakNewPassword"));
          break;
        case "SamePasswordRejected":
          setPwError(t("settings.account.samePassword"));
          break;
        case "InvalidVaultMeta":
          setPwError(t("settings.account.vaultUnreadable"));
          break;
        case "IoError":
          setPwError(ioBanner(e.detail.io_error_kind));
          break;
        case "VaultMetaChangedExternally":
        case "VaultLockedDuringChange":
          // Slot dropped during the change — force a relock.
          wipeRef.current();
          onLock();
          return;
        default:
          setPwError(t("settings.account.genericChangeError"));
      }
      setPwBusy(false);
    }
  }

  const canDelete = confirmText.trim().toUpperCase() === "DELETE";

  async function submitDelete() {
    if (!canDelete || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      // Id-targeted erase (SYNC-6), and the id is REQUIRED since
      // myne-md/myne#476, the same contract `AccountPanel` has held on desktop
      // since #250. An unresolved target means we do not know which vault the
      // user is looking at, and this button is irreversible. Refuse, do not
      // guess: this prop is optional, so before the signature change it was
      // passed straight through as `undefined` and the backend answered with a
      // deserialization rejection the catch below reported as a delete failure.
      if (vaultId == null) {
        // Refuse quietly rather than with `deleteVault.deleteError`, which reads
        // "Couldn't fully delete the vault. Please try again." Nothing was
        // attempted, so it misdescribes what happened, and "try again" is advice
        // that cannot work while the id is unresolved. The window is real rather
        // than purely defensive: `EditorFlow` resolves `activeVaultId()`
        // asynchronously on the post-reload entry, so this prop is briefly
        // undefined there.
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[SettingsSheet] vault_delete refused: no resolved vault id");
        }
        setDeleteBusy(false);
        return;
      }
      if (HAS_TAURI) await deleteVault(vaultId);
      onDeleteVaultSuccess();
    } catch {
      setDeleteError(t("settings.deleteVault.deleteError"));
      setDeleteBusy(false);
    }
  }

  // ── Sheet header (title + back/close) ──────────────────────────────────────
  const headerTitle = t(PANEL_TITLE[panel]);

  return (
    <Sheet onClose={onClose} style={{ maxHeight: "88%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {(close) => (
        <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 2px 12px" }}>
        {panel === "root" ? (
          <span style={{ width: 60 }} />
        ) : (
          <button
            onClick={goBack}
            // Icon-only: the chevron is the whole control, so without this it
            // is announced as "button" and nothing else — on the only way back
            // out of a settings sub-panel (myne-md/myne#775). WCAG 2.2 AA
            // 4.1.2, which `PRODUCT.md` commits to.
            aria-label={t("common.back")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              border: "none",
              background: "transparent",
              color: "var(--accent)",
              fontSize: 15,
              fontWeight: 500,
              cursor: "pointer",
              padding: 0,
              width: 60,
            }}
          >
            <Icon name="chevron-left" size={18} color="var(--accent)" strokeWidth={2} flip />
          </button>
        )}
        <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>{headerTitle}</div>
        <button
          onClick={close}
          style={{
            width: 60,
            textAlign: "end",
            border: "none",
            background: "transparent",
            color: "var(--accent)",
            fontSize: 15,
            fontWeight: 600,
            cursor: "pointer",
            padding: 0,
          }}
        >
          {t("settings.done")}
        </button>
      </div>

      <div ref={scrollRef} style={{ overflowY: "auto", minHeight: 0 }}>
        {panel === "root" && (
          <>
            <SectionLabel mt={6}>{t("settings.sectionOptions")}</SectionLabel>
            <Group>
              <CategoryRow first glyph="account" label={t("settings.shell.panels.account")} value={vaultDisplayLabel(eff.label)} onClick={() => setPanel("account")} />
              <CategoryRow glyph="appearance" label={t("settings.shell.panels.appearance")} onClick={() => setPanel("appearance")} />
              <CategoryRow glyph="editor" label={t("settings.shell.panels.editor")} onClick={() => setPanel("editor")} />
              <CategoryRow
                glyph="privacy"
                label={t("settings.panelTitle.privacy")}
                value={quStatus?.configured && quStatus.method === "pin" ? t("settings.quickUnlock.methodPin") : undefined}
                onClick={() => setPanel("privacy")}
              />
              <CategoryRow glyph="data" label={t("settings.panelTitle.data")} onClick={() => setPanel("data")} />
              {/* Value column carries the CURRENT state rather than a badge:
                  "Off" is the shipped default and the honest thing to show, and
                  a named provider tells the user where their notes would go
                  without opening the panel. */}
              <CategoryRow
                glyph="ai"
                label={t("settings.shell.panels.ai")}
                value={aiSummary(eff, t)}
                testId="settings.category-ai"
                onClick={() => setPanel("ai")}
              />
              <CategoryRow glyph="sync" label={t("settings.shell.panels.sync")} value={syncSummary(syncStatus, t)} onClick={() => setPanel("sync")} />
              <CategoryRow glyph="about" label={t("settings.shell.panels.about")} value={__APP_VERSION__} onClick={() => setPanel("about")} />
            </Group>

            <button
              onClick={onLock}
              style={{
                marginTop: 20,
                width: "100%",
                height: 48,
                border: "1px solid var(--line-1)",
                borderRadius: 10,
                background: "var(--bg-1)",
                color: "var(--danger)",
                fontFamily: "var(--font-sans)",
                fontSize: 16,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("commands.actions.lockVault.label")}
            </button>

            <SectionLabel>{t("settings.account.dangerZoneHeading")}</SectionLabel>
            <button
              onClick={() => setPanel("delete-vault")}
              style={{
                width: "100%",
                height: 48,
                border: "1px solid color-mix(in srgb, var(--danger) 25%, transparent)",
                borderRadius: 10,
                background: "var(--danger-soft)",
                color: "var(--danger)",
                fontFamily: "var(--font-sans)",
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("settings.deleteVault.heading")}
            </button>

            <div style={{ marginTop: 16, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)" }}>
              {t("settings.footerTagline")}
            </div>
          </>
        )}

        {panel === "account" && (
          <div style={{ marginTop: 4 }}>
            <Group>
              <Row
                first
                onClick={() => {
                  setRenameText(eff.label ?? "");
                  setPanel("rename");
                }}
              >
                <span style={rowLabel}>{t("settings.panelTitle.vaultName")}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 16, color: "var(--fg-3)" }}>{vaultDisplayLabel(eff.label)}</span>
                  <RowChevron />
                </span>
              </Row>
              <Row onClick={() => setPanel("change-password")}>
                <span style={rowLabel}>{t("settings.changePassword.title")}</span>
                <RowChevron />
              </Row>
            </Group>

            {/* Vault icon (vault-icons) — the switcher/header glyph. Inline
                rather than a drill-down panel: it is a one-tap terminal choice
                with instant read-back, unlike the rename below it, which needs a
                field, a keyboard and an explicit save. Same control as desktop's
                Account panel, so the two settings screens stay diff-able. */}
            <FieldLabel mt={18}>{t("settings.account.vaultIconLabel")}</FieldLabel>
            <div
              role="radiogroup"
              aria-label={t("settings.account.vaultIconLabel")}
              data-testid="settings.icon-picker"
              style={ICON_GRID_STYLE}
            >
              <button
                type="button"
                role="radio"
                aria-checked={eff.icon === null}
                aria-label={t("settings.account.vaultIconDefault")}
                data-testid="settings.icon-option"
                data-icon-name="default"
                onClick={() => selectIcon(null)}
                style={{ ...ICON_BTN_STYLE, borderColor: eff.icon === null ? "var(--accent)" : "var(--line-2)" }}
              >
                <MyneMark size={22} radius={4} />
              </button>
              {FOLDER_ICON_NAMES.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={eff.icon === name}
                  aria-label={name}
                  data-testid="settings.icon-option"
                  data-icon-name={name}
                  onClick={() => selectIcon(name)}
                  style={{ ...ICON_BTN_STYLE, borderColor: eff.icon === name ? "var(--accent)" : "transparent" }}
                >
                  <FolderGlyph name={name} size={22} />
                </button>
              ))}
            </div>
          </div>
        )}

        {panel === "appearance" && (
          <div style={PANEL_STACK}>
            <div style={{ padding: "12px 14px", border: "1px solid var(--line-1)", borderRadius: 10, background: "var(--bg-1)" }}>
              <div style={{ fontSize: 16, marginBottom: 10, color: "var(--fg-1)" }}>{t("settings.appearance.themeLabel")}</div>
              <div style={{ display: "flex", gap: 4, background: "var(--bg-2)", border: "1px solid var(--line-1)", borderRadius: 8, padding: 3 }}>
                {THEME_CHOICES.map((c) => {
                  const on = choice === c.key;
                  return (
                    <div
                      key={c.key}
                      {...tappable({ onActivate: () => void pickTheme(c.key), pressed: on })}
                      style={{
                        flex: 1,
                        textAlign: "center",
                        padding: "8px 0",
                        borderRadius: 6,
                        fontSize: 13,
                        cursor: "pointer",
                        background: on ? "var(--bg-1)" : "transparent",
                        border: on ? "1px solid var(--line-1)" : "1px solid transparent",
                        fontWeight: on ? 600 : 400,
                        color: on ? "var(--fg-1)" : "var(--fg-2)",
                      }}
                    >
                      {t(c.labelKey)}
                    </div>
                  );
                })}
              </div>
            </div>
            <CustomThemesBlock
              entries={customThemes}
              selected={eff.custom_theme}
              onPick={(entry) => void pickCustomTheme(entry)}
            />
            <LanguageBlock />
            <SegmentBlock
              label={t("settings.typography.textSizeLabel")}
              options={["sm", "md", "lg", "xl"]}
              labels={[t("settings.appearance.sizeS"), t("settings.appearance.sizeM"), t("settings.appearance.sizeL"), t("settings.appearance.sizeXL")]}
              value={eff.editor_text_size ?? "md"}
              onPick={(v) => writeDraftPref("editor_text_size", v, () => setEditorTextSize(v))}
            />
            <SegmentBlock
              label={t("settings.appearance.editorFont")}
              options={["mono", "sans"]}
              labels={[t("editor.typography.font.mono"), t("editor.typography.font.sans")]}
              value={eff.editor_font_family ?? "mono"}
              onPick={(v) => writeDraftPref("editor_font_family", v, () => setEditorFontFamily(v))}
            />
            <SegmentBlock
              label={t("settings.typography.lineSpacingLabel")}
              options={["tight", "normal", "relaxed"]}
              labels={[t("editor.typography.lineSpacing.tight"), t("editor.typography.lineSpacing.normal"), t("editor.typography.lineSpacing.relaxed")]}
              value={eff.editor_line_spacing ?? "normal"}
              onPick={(v) => writeDraftPref("editor_line_spacing", v, () => setEditorLineSpacing(v))}
            />
            <Group>
              <ToggleRow
                first
                title={t("settings.appearance.showEditTimesLabel")}
                subtitle={t("settings.appearance.showEditTimesSubtitle")}
                on={eff.show_note_timestamps}
                onToggle={() => writeDraftPref("show_note_timestamps", !eff.show_note_timestamps, () => setShowNoteTimestamps(!eff.show_note_timestamps))}
              />
            </Group>
            {/* Home quick-action tiles — show/hide each individually (MYND-479). */}
            <SectionLabel>{t("settings.appearance.homeQuickActions")}</SectionLabel>
            <Group>
              <ToggleRow
                first
                title={t("notes.newTab.createDrawing")}
                on={!hiddenHomeTiles.has("new-drawing")}
                onToggle={() => setHomeTileHidden("new-drawing", !hiddenHomeTiles.has("new-drawing"))}
              />
              <ToggleRow
                title={t("templates.manager.listLabel")}
                on={!hiddenHomeTiles.has("templates")}
                onToggle={() => setHomeTileHidden("templates", !hiddenHomeTiles.has("templates"))}
              />
              <ToggleRow
                title={t("editor.nav.openToday")}
                on={!hiddenHomeTiles.has("open-today")}
                onToggle={() => setHomeTileHidden("open-today", !hiddenHomeTiles.has("open-today"))}
              />
              <ToggleRow
                title={t("editor.chrome.barItems.views")}
                on={!hiddenHomeTiles.has("views")}
                onToggle={() => setHomeTileHidden("views", !hiddenHomeTiles.has("views"))}
              />
            </Group>
          </div>
        )}

        {panel === "editor" && (
          <div style={PANEL_STACK}>
            <SegmentBlock
              label={t("settings.editor.defaultView")}
              options={["live", "reading", "source"]}
              labels={[t("editor.chrome.viewMode.live"), t("settings.viewMode.optionReading"), t("settings.viewMode.optionSource")]}
              value={eff.editor_default_view_mode ?? "live"}
              onPick={(v) => writeDraftPref("editor_default_view_mode", v, () => setEditorDefaultViewMode(v))}
            />
            <Group>
              <ToggleRow
                first
                title={t("settings.spell.label")}
                on={eff.spell_enabled ?? true}
                onToggle={() => writeDraftPref("spell_enabled", !(eff.spell_enabled ?? true), () => setSpellEnabled(!(eff.spell_enabled ?? true)))}
              />
              <ToggleRow
                title={t("settings.lineNumbers.label")}
                on={eff.editor_line_numbers ?? false}
                onToggle={() => writeDraftPref("editor_line_numbers", !(eff.editor_line_numbers ?? false), () => setEditorLineNumbers(!(eff.editor_line_numbers ?? false)))}
              />
              <ToggleRow
                title={t("settings.editor.typewriter")}
                subtitle={t("settings.editor.typewriterSubtitle")}
                on={eff.editor_focus_typewriter ?? false}
                onToggle={() => writeDraftPref("editor_focus_typewriter", !(eff.editor_focus_typewriter ?? false), () => setEditorFocusTypewriter(!(eff.editor_focus_typewriter ?? false)))}
              />
              <ToggleRow
                title={t("settings.focusMode.dimAria")}
                on={eff.editor_focus_dim_inactive ?? false}
                onToggle={() => writeDraftPref("editor_focus_dim_inactive", !(eff.editor_focus_dim_inactive ?? false), () => setEditorFocusDimInactive(!(eff.editor_focus_dim_inactive ?? false)))}
              />
              <ToggleRow
                title={t("settings.editor.enableArchiving")}
                on={!(eff.archive_disabled ?? false)}
                onToggle={() => {
                  const nextDisabled = !(eff.archive_disabled ?? false);
                  writeDraftPref("archive_disabled", nextDisabled, () => setArchiveDisabled(nextDisabled));
                }}
              />
            </Group>
            {/* Date & time (myne#279, reached mobile in myne-md/myne#609). In
                the Editor panel, matching the desktop, where the same three rows
                live in `EditorPanel`. Two of them arrive by sync and are here so
                the phone can change them; the third, the zone, is device-local
                and this is the ONLY place it can be set at all. */}
            <DateTimeBlock
              dateFormat={asDateFormat(eff.date_format)}
              timeFormat={asTimeFormat(eff.time_format)}
              timezone={eff.timezone ?? ""}
              onDate={(v) => writeDraftPref("date_format", v, () => setDateFormat(v))}
              onTime={(v) => writeDraftPref("time_format", v, () => setTimeFormat(v))}
              onZone={(v, onFailed) => writeDraftPref("timezone", v, () => setTimezone(v), onFailed)}
            />
            {/* MYND-555: the format-bar layout editor is its own panel — it is a
                12-row reorder/hide list, too tall to inline under the toggles. */}
            <Group>
              <Row first onClick={() => setPanel("format-bar")} testId="settings.format-bar-row">
                <span style={rowLabel}>{t("settings.toolbarCustomize.label")}</span>
                <RowChevron />
              </Row>
            </Group>
          </div>
        )}

        {panel === "format-bar" && (
          <FormatBarPanel
            order={eff.editor_toolbar_order}
            hidden={eff.editor_toolbar_hidden}
            onOrder={(next) => writeDraftPref("editor_toolbar_order", next, () => setEditorToolbarOrder(next))}
            onHidden={(next) => writeDraftPref("editor_toolbar_hidden", next, () => setEditorToolbarHidden(next))}
          />
        )}

        {panel === "privacy" && (
          <div style={PANEL_STACK}>
            <Group>
              <ToggleRow
                first
                title={t("settings.privacy.screenCaptureLabel")}
                subtitle={t("settings.privacy.screenCaptureSubtitle")}
                on={eff.screen_capture_protection}
                onToggle={() => writeDraftPref("screen_capture_protection", !eff.screen_capture_protection, () => setScreenCaptureProtection(!eff.screen_capture_protection))}
              />
              {/* On-device voice-to-text (MYND-563; opt-out, default on). The
                  transcribe command re-reads this host-side, so the toggle only
                  governs whether the feature runs + shows. */}
              <ToggleRow
                title={t("settings.transcription.label")}
                subtitle={t("settings.transcription.helper")}
                on={eff.transcription_enabled}
                onToggle={() => writeDraftPref("transcription_enabled", !eff.transcription_enabled, () => setTranscriptionEnabled(!eff.transcription_enabled))}
                testId="settings.transcription-toggle"
              />
            </Group>
            {/* Directly after screen-capture protection rather than beside the
                lock timers (myne-md/myne#411): both answer the same question,
                which is what somebody holding this phone can see. Its own card
                because its two bounds are always-visible sentences under the
                row, not a subtitle. See the block for why they are not behind
                a chevron. */}
            <HideVaultNamesBlock />
            {/* The recovery drill (myne-md/myne#468). Beside the lock timers and
                the hide-names switch rather than under Account, because what it
                protects is the ability to get back IN — the same family as its
                neighbours — and because Account is where the vault's name and
                number live, where a phrase field would read as one more
                identifier to manage. The desktop twin sits in the same place for
                the same reason. */}
            <RecoveryDrillBlock />
            <SegmentBlock
              label={t("settings.privacy.autoLockAfter")}
              options={[60, 300, 900, 1800, 3600]}
              labels={[t("settings.privacy.autoLock1m"), t("settings.privacy.autoLock5m"), t("settings.privacy.autoLock15m"), t("settings.privacy.autoLock30m"), t("settings.privacy.autoLock1h")]}
              value={eff.auto_lock_seconds ?? 300}
              onPick={(v) => writeDraftPref("auto_lock_seconds", v, () => setAutoLockTimeout(v))}
            />
            <Group>
              <Row first onClick={() => setPanel("quick-unlock")} testId="settings.quick-unlock-row">
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={rowLabel}>{t("settings.quickUnlock.title")}</span>
                  <span style={{ fontSize: 13, color: "var(--fg-3)" }}>
                    {isAndroid ? t("settings.privacy.quickUnlockSubtitleAndroid") : t("settings.privacy.quickUnlockSubtitle", { method: biometric })}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 15, color: "var(--fg-3)" }} data-testid="settings.quick-unlock-value">
                    {quStatus?.configured ? (quStatus.method === "pin" ? t("settings.quickUnlock.methodPin") : biometric) : t("settings.archive.off")}
                  </span>
                  <RowChevron />
                </div>
              </Row>
            </Group>
            {/* Reminders live here rather than in a rail entry of their own:
                the rail is governance-locked, and what this block has to say —
                that reminder times leave the encrypted vault, and how precisely
                this phone will deliver them — is a privacy statement before it
                is a preference (MYND-619 tasks 6 + 8). The switch owns the
                section heading; the precise-delivery row sits under it and
                renders nothing at all on a platform with no such permission. */}
            <ReminderSwitchBlock
              enabled={eff.reminders_enabled}
              horizonDays={eff.reminder_horizon_days}
              onEnabledChange={(next) =>
                writeDraftPref("reminders_enabled", next, () => setRemindersEnabled(next))
              }
              onHorizonChange={(next) =>
                writeDraftPref("reminder_horizon_days", next, () => setReminderHorizonDays(next))
              }
            />
            {/* Gated on the same predicate as the horizon line (myne#508).
                It offers to make delivery precise, and asks Android for the
                exact-alarm special access to do it, for a pass that has no
                caller: nothing is scheduled, so there is no imprecision to fix
                and no reason to request a permission Google requires a Play
                Console declaration for. One predicate gates every claim this
                screen makes about an operating system delivering anything. */}
            {eff.reminders_enabled && remindersReachTheOs() && <ExactAlarmBlock />}
          </div>
        )}

        {panel === "data" && (
          <div style={PANEL_STACK}>
            <Group>
              <ToggleRow
                first
                title={t("settings.attachmentCompression.label")}
                subtitle={t("settings.attachmentCompression.helper")}
                on={eff.attachment_compression_enabled}
                onToggle={() => writeDraftPref("attachment_compression_enabled", !eff.attachment_compression_enabled, () => setAttachmentCompressionEnabled(!eff.attachment_compression_enabled))}
                testId="settings.attachment-compression"
              />
            </Group>
            <Group>
              <Row first onClick={exporting ? undefined : () => void runExport()}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={rowLabel}>{t("settings.data.exportToMarkdown")}</span>
                  <span style={{ fontSize: 13, color: "var(--fg-3)" }}>
                    {t("settings.data.exportToMarkdownSubtitle")}
                  </span>
                </div>
                {exporting ? <Spinner size={18} /> : <RowChevron />}
              </Row>
            </Group>
          </div>
        )}

        {panel === "ai" && (
          <AiPanel
            prefs={eff}
            hasKey={aiHasKey}
            models={aiModels}
            modelsState={aiModelsState}
            onEnabled={(on) => writeDraftPref("ai_enabled", on, () => setAiEnabled(on))}
            onProvider={(wire) => {
              // **Only when the selection ACTUALLY changes.** The host clears
              // the key and the model on a change, so resetting the local view
              // mirrors it. But the "approve sending on this phone" row calls
              // this with the provider that is already selected, and on that
              // path nothing is cleared host-side: resetting anyway made a
              // phone that inherited a key report "no key stored", offer "Save
              // key" instead of "Replace key", and hide the model chooser that
              // every request needs. The re-read that would correct it is keyed
              // on `eff.ai_provider`, which by definition did not move.
              if (wire !== eff.ai_provider) {
                setAiModels([]);
                setAiModelsState("idle");
                setAiHasKey(false);
              }
              if (wire === null) {
                writeDraftPref("ai_provider", null, () => setAiProvider(null));
                return;
              }
              // **The consent screen, unless THIS DEVICE has already approved
              // this provider.** The comparison is against the local consent
              // rather than against "has a consent": an approval recorded for a
              // different recipient is not transferable, which is why the field
              // stores a provider NAME and why the host compares it for
              // equality rather than reading a boolean.
              //
              // A vault configured on a laptop arrives here with the provider,
              // the model and the key already set and `ai_provider_consent`
              // empty, because myne-md/myne#456 made that field device-local.
              // This branch is what that change exists for.
              if (consentIsDeviceScoped(eff.ai_provider_consent, wire)) {
                writeDraftPref("ai_provider", wire, () => setAiProvider(wire));
                return;
              }
              setAiConsentFor(wire);
            }}
            onKey={(key) => {
              // Optimistic, like every other write here, but on a value the
              // draft cannot hold: there is no `ai_provider_key` in `PrefsView`.
              // So the optimism is the has-key boolean, and a failed write
              // reverts it.
              setAiHasKey(true);
              if (!HAS_TAURI) return;
              void setAiProviderKey(key).catch(() => {
                setAiHasKey(false);
                setToast(t("settings.saveSettingError"));
              });
            }}
            onModel={(m) => writeDraftPref("ai_provider_model", m, () => setAiProviderModel(m))}
            onLoadModels={loadAiModels}
            onRevoke={revokeAiProvider}
            onToast={(message) => setToast(message)}
          />
        )}

        {/* **Over the panel, not beside it.** The accepting action is rendered
            by this component and only by this component, so there is no route
            to a recorded consent that skips the disclosure. Dismissing stores
            nothing. */}
        {panel === "ai" && aiConsentFor !== null && (
          <AiConsentScreen
            provider={aiConsentFor}
            onCancel={() => setAiConsentFor(null)}
            onAccept={async () => {
              const wire = aiConsentFor;
              setAiConsentFor(null);
              // **The PROVIDER first, then the consent, and the order is not a
              // preference.** `set_ai_provider_with_dir` clears
              // `ai_provider_consent`, `ai_provider_key` and
              // `ai_provider_model` whenever the selection CHANGES, which on a
              // first-time approval it always has. Writing the consent first
              // therefore had it erased by the very next call, leaving a device
              // that looks configured, refuses every request as
              // `ConsentMissing`, and hides its own recovery row: the optimistic
              // draft keeps rendering the consent as granted until the sheet is
              // closed and reopened.
              //
              // The desktop twin already carries this order under a comment
              // naming the same failure. This copy had the opposite order and an
              // argument for it, which is the more expensive kind of wrong.
              // AWAITED, which is what makes the order above real. The
              // comment predates the await: `writeDraftPref` used to fire
              // and forget, so both commands raced to the prefs mutex and
              // the order written here decided nothing.
              await writeDraftPref("ai_provider", wire, () => setAiProvider(wire));
              writeDraftPref("ai_provider_consent", wire, () =>
                setAiProviderConsent(wire),
              );
            }}
          />
        )}

        {panel === "sync" && (
          <SyncHubPanel
            status={syncStatus}
            onSyncNow={syncNow}
            syncing={syncBusy}
            onOpenEndpoint={() => setPanel("sync-endpoint")}
            onOpenEnroll={() => setPanel("sync-enroll")}
            onOpenDevices={() => setPanel("sync-devices")}
            onOpenMembers={() => setPanel("sync-members")}
          />
        )}

        {panel === "sync-endpoint" && <SyncEndpointPanel />}

        {panel === "sync-enroll" && <SyncEnrollPanel onEnrolled={() => setPanel("sync")} />}

        {panel === "sync-devices" && <SyncDevicesPanel />}

        {panel === "sync-members" && <SyncMembersPanel />}

        {panel === "about" && (
          <div style={{ marginTop: 4 }}>
            <Group>
              <Row first>
                <span style={rowLabel}>{t("settings.about.version")}</span>
                {/* `__APP_VERSION__`, not a literal. `mobile/vite.config.ts`
                    injects it from `mobile/package.json` and says in its own
                    comment that this row reads it — which was not true: the
                    literal here said `0.1.0` while the app shipped 0.5.0, so a
                    mobile About screen named a version four minors old and every
                    bug report from it pointed at a source tree that could not
                    contain the bug. myne-md/myne#555, `settings.panel.about`. */}
                <span style={{ fontSize: 16, color: "var(--fg-3)" }}>
                  {__APP_VERSION__} · {import.meta.env.MODE === "production" ? t("settings.about.buildChannelStable") : t("settings.about.dev")}
                </span>
              </Row>
              <Row>
                <span style={rowLabel}>{t("settings.about.licenseLabel")}</span>
                <span style={{ fontSize: 16, color: "var(--fg-3)" }}>AGPL-3.0</span>
              </Row>
            </Group>

            {/* The published legal documents (operations#15). They open on
                myne.md in the phone's browser rather than being embedded, so
                there is one text per document and no way for an app build to
                carry a stale one. `↗` rather than a chevron: a chevron here
                means "drills into another panel", and these leave the app.

                The Impressum is deliberately not listed — see the same
                omission and its reason in the desktop About panel. */}
            <SectionLabel>{t("settings.about.legalLabel")}</SectionLabel>
            <Group>
              {LEGAL_LINKS.map(({ doc, labelKey, testId }, i) => (
                <Row
                  key={doc}
                  first={i === 0}
                  onClick={() => {
                    void openUrl(legalUrl(doc, i18n.language));
                  }}
                  testId={testId}
                >
                  <span style={rowLabel}>{t(labelKey)}</span>
                  <span style={{ fontSize: 15, color: "var(--fg-3)", flex: "none" }} aria-hidden="true">
                    ↗
                  </span>
                </Row>
              ))}
            </Group>

            <div style={{ marginTop: 16, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)" }}>
              {t("settings.footerTagline")}
            </div>
          </div>
        )}

        {panel === "rename" && (
          <div>
            <FieldLabel mt={4}>{t("settings.panelTitle.vaultName")}</FieldLabel>
            <SheetInput value={renameText} onChange={setRenameText} autoFocus placeholder={vaultDisplayLabel(null)} />
            <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
              {t("settings.account.renameHelper")}
            </div>
            <div style={{ marginTop: 18 }}>
              <Button onClick={submitRename}>{t("settings.account.vaultLabelSave")}</Button>
            </div>
          </div>
        )}

        {panel === "quick-unlock" && (
          <div>
            {pinError && (
              <Banner kind="danger" style={{ marginBottom: 4 }}>
                {pinError}
              </Banner>
            )}
            <div
              style={{
                marginTop: 4,
                background: "var(--warning-soft)",
                border: "1px solid color-mix(in srgb, var(--warning) 28%, transparent)",
                borderRadius: 8,
                padding: "11px 13px",
                fontSize: 13,
                lineHeight: 1.5,
                color: "var(--warning)",
              }}
            >
              {t("settings.quickUnlock.warningBanner")}
            </div>
            {!isAndroid && (
              <div style={{ marginTop: 12 }}>
                <Group>
                  <ToggleRow
                    first
                    title={biometric}
                    subtitle={t("settings.quickUnlock.biometricToggleSubtitle", { method: biometric })}
                    on={quStatus?.method === "biometric"}
                    onToggle={() =>
                      void (quStatus?.method === "biometric" ? disableBiometric() : enableBiometric())
                    }
                    testId="settings.quick-unlock-biometric-toggle"
                  />
                </Group>
              </div>
            )}
            {quStatus?.configured && quStatus.method === "pin" ? (
              <>
                <div style={{ marginTop: 14, fontSize: 15, lineHeight: 1.55, color: "var(--fg-2)" }}>
                  {t("settings.quickUnlock.pinOnLead")}
                  <strong style={{ color: "var(--fg-1)" }}>{t("settings.quickUnlock.pinOnEmphasis")}</strong>
                  {t("settings.quickUnlock.pinOnRest")}
                </div>
                <div style={{ marginTop: 18 }}>
                  <Button variant="danger" onClick={disableQuickUnlock} disabled={pinBusy}>
                    {t("settings.quickUnlock.turnOffPin")}
                  </Button>
                </div>
              </>
            ) : quStatus?.method === "biometric" ? (
              // Biometric quick-unlock is configured (MYND-482): quick-unlock is
              // already set up, so DON'T show a "Set up" PIN form (setting a PIN
              // would silently overwrite the biometric credential). Reflect the
              // state + point to the toggle above as the explicit way to switch.
              <div data-testid="settings.quick-unlock-biometric-configured" style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
                {t("settings.quickUnlock.helperConfigured", { method: biometric })}
              </div>
            ) : (
              <>
                {/* Observability only (`src/AGENTS.md` "Test observability"): the
                    PIN path is what must SURVIVE on a platform with no biometric
                    provider, so a scenario asserting the biometric toggle's
                    absence needs a stable handle on the thing that stayed.
                    Without one the absence assertion passes just as well on a
                    panel that rendered nothing at all. */}
                <div
                  data-testid="settings.quick-unlock-pin-setup"
                  style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}
                >
                  {t("settings.quickUnlock.pinSetupHelper")}
                </div>
                <FieldLabel mt={14}>{t("settings.quickUnlock.methodPin")}</FieldLabel>
                <SheetInput type="password" inputMode="numeric" value={pin} onChange={setPin} placeholder={t("settings.quickUnlock.pinPlaceholder6")}  />
                <FieldLabel mt={12}>{t("settings.quickUnlock.confirmPin")}</FieldLabel>
                <SheetInput type="password" inputMode="numeric" value={pinConfirm} onChange={setPinConfirm} placeholder={t("settings.quickUnlock.reenterPin")} />
                <div style={{ marginTop: 18 }}>
                  <Button onClick={submitSetupPin} disabled={pinBusy}>
                    {t("settings.quickUnlock.setupButton")}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {panel === "change-password" && (
          <div>
            {pwError && (
              <Banner kind="danger" style={{ marginBottom: 4 }}>
                {pwError}
              </Banner>
            )}
            <FieldLabel mt={pwError ? 10 : 4}>{t("settings.changePassword.currentLabel")}</FieldLabel>
            <SheetInput type="password" value={currentPw} onChange={setCurrentPw} autoFocus placeholder={t("settings.changePassword.currentLabel")} />
            <FieldLabel mt={16}>{t("settings.changePassword.newLabel")}</FieldLabel>
            <SheetInput type="password" value={newPw} onChange={setNewPw} placeholder={t("settings.account.newPasswordPlaceholder")} />
            {newPw.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <StrengthMeter level={strengthLevel(newPw.length)} />
              </div>
            )}
            <FieldLabel mt={16}>{t("settings.changePassword.confirmLabel")}</FieldLabel>
            <SheetInput type="password" value={confirmPw} onChange={setConfirmPw} placeholder={t("settings.account.reenterNewPassword")} />
            <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
              {t("settings.account.changePasswordFootnote")}
            </div>
            <div style={{ marginTop: 18 }}>
              <Button onClick={submitChangePassword} disabled={pwBusy}>
                {pwBusy ? t("settings.account.changing") : t("settings.changePassword.title")}
              </Button>
            </div>
          </div>
        )}

        {panel === "delete-vault" && (
          <div>
            <Banner kind="danger" style={{ marginBottom: 14 }}>
              {t("settings.deleteVault.warning")}
            </Banner>
            {deleteError && (
              <Banner kind="danger" style={{ marginBottom: 14 }}>
                {deleteError}
              </Banner>
            )}
            <FieldLabel mt={0}>{t("settings.deleteVault.typeToConfirmLabel")}</FieldLabel>
            <SheetInput value={confirmText} onChange={setConfirmText} placeholder="DELETE" mono />
            <div style={{ marginTop: 18 }}>
              <button
                onClick={submitDelete}
                disabled={!canDelete || deleteBusy}
                style={{
                  width: "100%",
                  height: 50,
                  border: "none",
                  borderRadius: 8,
                  background: canDelete ? "var(--danger)" : "color-mix(in srgb, var(--danger) 35%, var(--bg-2))",
                  color: "#fff",
                  fontFamily: "var(--font-sans)",
                  fontSize: 16,
                  fontWeight: 600,
                  cursor: canDelete && !deleteBusy ? "pointer" : "not-allowed",
                  opacity: canDelete ? 1 : 0.7,
                }}
              >
                {deleteBusy ? t("attachments.deleteDialog.deleting") : t("settings.deleteVault.deleteButton")}
              </button>
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div style={{ position: "absolute", insetInlineStart: 0, insetInlineEnd: 0, bottom: 92, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
          <Toast icon="check">{toast}</Toast>
        </div>
      )}
        </>
      )}
    </Sheet>
  );
}
