import { type ChangeEvent, type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { setLanguage } from "@myne/i18n";
import { SUPPORTED_LANGUAGES, SUPPORTED_CODES, type LanguageCode } from "@myne/i18n/config";
import { Sheet, Banner, Button, Icon, Toast, StrengthMeter, Switch, Segmented, Spinner, ThemeChiplet, FolderGlyph, MyneMark } from "../../components";
import { FOLDER_ICON_NAMES } from "@myne/decorations/folderIcons";
import { SyncHubPanel, SyncEndpointPanel, SyncEnrollPanel, SyncDevicesPanel } from "../../components";
import { ExactAlarmBlock, ReminderSwitchBlock } from "../../components";
import { HideVaultNamesBlock } from "../../components";
import { applyTheme } from "../../platform/theme";
import type { ThemeName } from "../../platform/PlatformContext";
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
import { usePlatform } from "../../platform/PlatformContext";
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
import { bumpPrefsNonce } from "../../lib/prefsNonce";
import { vaultDisplayLabel, VAULT_FALLBACK_LABEL } from "../../lib/vault-label";
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
  setRemindersEnabled,
} from "../../lib/prefs";
import { formatBarLabelKey, resolveFormatBarOrder } from "../../lib/formatBarItems";
import type { VaultChangePasswordError } from "../../types/vault-change-password-error";
import type { VaultId } from "../../lib/stage";

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
      onClick={onClick}
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
  type = "text",
  placeholder,
  autoFocus = false,
  mono = false,
  inputMode,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "password";
  placeholder?: string;
  autoFocus?: boolean;
  mono?: boolean;
  inputMode?: "numeric";
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
}: {
  label: string;
  options: readonly T[];
  labels: string[];
  value: T;
  onPick: (v: T) => void;
}) {
  const active = Math.max(0, options.indexOf(value));
  return (
    <div style={CARD_STYLE}>
      <div style={{ fontSize: 16, marginBottom: 10, color: "var(--fg-1)" }}>{label}</div>
      <Segmented options={labels} active={active} onChange={(i) => onPick(options[i])} />
    </div>
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
    <div style={CARD_STYLE}>
      <div style={{ fontSize: 16, marginBottom: 10, color: "var(--fg-1)" }}>{t("settings.language.label")}</div>
      <select
        value={value}
        onChange={(e) => setLanguage(e.currentTarget.value as LanguageCode)}
        aria-label={t("settings.language.label")}
        data-testid="settings.language-select"
        style={{
          width: "100%",
          height: 44,
          border: "1px solid var(--line-2)",
          borderRadius: 6,
          background: "var(--bg-1)",
          padding: "0 12px",
          fontFamily: "var(--font-sans)",
          fontSize: 16,
          color: "var(--fg-1)",
          cursor: "pointer",
          appearance: "none",
          WebkitAppearance: "none",
        }}
      >
        {SUPPORTED_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
      <div style={{ marginTop: 8, fontSize: 12, color: "var(--fg-3)", lineHeight: 1.4 }}>{t("settings.language.helper")}</div>
    </div>
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
                // matching every other tappable row in this sheet (plain div +
                // onClick), so the block still carries no button.
                onClick={() => onPick(entry)}
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
  about: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 11.5v4.5" />
      <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  ),
};

/** A root drill-down row: leading glyph, label, optional trailing value, chevron. */
function CategoryRow({
  glyph,
  label,
  value,
  first = false,
  onClick,
}: {
  glyph: string;
  label: string;
  value?: string;
  first?: boolean;
  onClick: () => void;
}) {
  return (
    <Row first={first} onClick={onClick}>
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

type Panel =
  | "root"
  // category detail panels
  | "account"
  | "appearance"
  | "editor"
  | "privacy"
  | "data"
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
  | "sync-devices";

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
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
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
}

function strengthLevel(len: number): "Weak" | "Fair" | "Good" | "Strong" {
  if (len < 12) return "Weak";
  if (len < 16) return "Fair";
  if (len < 20) return "Good";
  return "Strong";
}

export function SettingsSheet({ vaultId, onClose, onLock, onDeleteVaultSuccess }: SettingsSheetProps) {
  const { t, i18n } = useTranslation();
  const { biometric, isAndroid } = usePlatform();
  const [panel, setPanel] = useState<Panel>("root");
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
  const [renameText, setRenameText] = useState("");

  /** Optimistic prefs setter: reflect instantly, persist, revert the one key on
   *  failure. On success bumps the shared prefs nonce so EVERY `usePrefs`
   *  consumer (this sheet + the live editor behind it) re-reads disk truth. In
   *  browser-dev (no Tauri host) the draft-only path keeps the UI interactive. */
  function writePref<K extends keyof PrefsView>(key: K, value: PrefsView[K], persist: () => Promise<void>) {
    setDraft((d) => ({ ...d, [key]: value }));
    if (!HAS_TAURI) return;
    void persist()
      .then(() => bumpPrefsNonce())
      .catch(() => {
        setDraft((d) => {
          const next = { ...d };
          delete next[key];
          return next;
        });
        setToast(t("settings.saveSettingError"));
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
      bumpPrefsNonce();
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
   * device is precisely what `docs/decisions.md` 2026-07-31 rules out.
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
      bumpPrefsNonce();
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
   *  Goes through `writePref`, not the `submitRename` shape below it: writePref
   *  reflects optimistically, bumps the prefs nonce on success so the header and
   *  sidebar marks re-read, and reverts THIS key with a toast on failure — which
   *  is why no in-flight/disabled state is needed. Re-picking the active glyph is
   *  a no-op. An unrecognized stored name matches no cell and is left alone: the
   *  field is Shared(ScalarLww), so normalizing it here would clobber a newer
   *  client's choice on the next merge. */
  const selectIcon = (name: string | null) => {
    if (name === eff.icon) return;
    writePref("icon", name, () => setVaultIcon(name));
  };

  async function submitRename() {
    const label = renameText.trim();
    try {
      if (HAS_TAURI) await setVaultLabel(label.length > 0 ? label : null);
      setDraft((d) => ({ ...d, label: label.length > 0 ? label : null }));
      bumpPrefsNonce();
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
              <CategoryRow glyph="sync" label={t("settings.shell.panels.sync")} value={syncSummary(syncStatus, t)} onClick={() => setPanel("sync")} />
              <CategoryRow glyph="about" label={t("settings.shell.panels.about")} value="0.1.0" onClick={() => setPanel("about")} />
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
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
            <div style={{ padding: "12px 14px", border: "1px solid var(--line-1)", borderRadius: 10, background: "var(--bg-1)" }}>
              <div style={{ fontSize: 16, marginBottom: 10, color: "var(--fg-1)" }}>{t("settings.appearance.themeLabel")}</div>
              <div style={{ display: "flex", gap: 4, background: "var(--bg-2)", border: "1px solid var(--line-1)", borderRadius: 8, padding: 3 }}>
                {THEME_CHOICES.map((c) => {
                  const on = choice === c.key;
                  return (
                    <div
                      key={c.key}
                      onClick={() => void pickTheme(c.key)}
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
              onPick={(v) => writePref("editor_text_size", v, () => setEditorTextSize(v))}
            />
            <SegmentBlock
              label={t("settings.appearance.editorFont")}
              options={["mono", "sans"]}
              labels={[t("editor.typography.font.mono"), t("editor.typography.font.sans")]}
              value={eff.editor_font_family ?? "mono"}
              onPick={(v) => writePref("editor_font_family", v, () => setEditorFontFamily(v))}
            />
            <SegmentBlock
              label={t("settings.typography.lineSpacingLabel")}
              options={["tight", "normal", "relaxed"]}
              labels={[t("editor.typography.lineSpacing.tight"), t("editor.typography.lineSpacing.normal"), t("editor.typography.lineSpacing.relaxed")]}
              value={eff.editor_line_spacing ?? "normal"}
              onPick={(v) => writePref("editor_line_spacing", v, () => setEditorLineSpacing(v))}
            />
            <Group>
              <ToggleRow
                first
                title={t("settings.appearance.showEditTimesLabel")}
                subtitle={t("settings.appearance.showEditTimesSubtitle")}
                on={eff.show_note_timestamps}
                onToggle={() => writePref("show_note_timestamps", !eff.show_note_timestamps, () => setShowNoteTimestamps(!eff.show_note_timestamps))}
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
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
            <SegmentBlock
              label={t("settings.editor.defaultView")}
              options={["live", "reading", "source"]}
              labels={[t("editor.chrome.viewMode.live"), t("settings.viewMode.optionReading"), t("settings.viewMode.optionSource")]}
              value={eff.editor_default_view_mode ?? "live"}
              onPick={(v) => writePref("editor_default_view_mode", v, () => setEditorDefaultViewMode(v))}
            />
            <Group>
              <ToggleRow
                first
                title={t("settings.spell.label")}
                on={eff.spell_enabled ?? true}
                onToggle={() => writePref("spell_enabled", !(eff.spell_enabled ?? true), () => setSpellEnabled(!(eff.spell_enabled ?? true)))}
              />
              <ToggleRow
                title={t("settings.lineNumbers.label")}
                on={eff.editor_line_numbers ?? false}
                onToggle={() => writePref("editor_line_numbers", !(eff.editor_line_numbers ?? false), () => setEditorLineNumbers(!(eff.editor_line_numbers ?? false)))}
              />
              <ToggleRow
                title={t("settings.editor.typewriter")}
                subtitle={t("settings.editor.typewriterSubtitle")}
                on={eff.editor_focus_typewriter ?? false}
                onToggle={() => writePref("editor_focus_typewriter", !(eff.editor_focus_typewriter ?? false), () => setEditorFocusTypewriter(!(eff.editor_focus_typewriter ?? false)))}
              />
              <ToggleRow
                title={t("settings.focusMode.dimAria")}
                on={eff.editor_focus_dim_inactive ?? false}
                onToggle={() => writePref("editor_focus_dim_inactive", !(eff.editor_focus_dim_inactive ?? false), () => setEditorFocusDimInactive(!(eff.editor_focus_dim_inactive ?? false)))}
              />
              <ToggleRow
                title={t("settings.editor.enableArchiving")}
                on={!(eff.archive_disabled ?? false)}
                onToggle={() => {
                  const nextDisabled = !(eff.archive_disabled ?? false);
                  writePref("archive_disabled", nextDisabled, () => setArchiveDisabled(nextDisabled));
                }}
              />
            </Group>
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
            onOrder={(next) => writePref("editor_toolbar_order", next, () => setEditorToolbarOrder(next))}
            onHidden={(next) => writePref("editor_toolbar_hidden", next, () => setEditorToolbarHidden(next))}
          />
        )}

        {panel === "privacy" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
            <Group>
              <ToggleRow
                first
                title={t("settings.privacy.screenCaptureLabel")}
                subtitle={t("settings.privacy.screenCaptureSubtitle")}
                on={eff.screen_capture_protection}
                onToggle={() => writePref("screen_capture_protection", !eff.screen_capture_protection, () => setScreenCaptureProtection(!eff.screen_capture_protection))}
              />
              {/* On-device voice-to-text (MYND-563; opt-out, default on). The
                  transcribe command re-reads this host-side, so the toggle only
                  governs whether the feature runs + shows. */}
              <ToggleRow
                title={t("settings.transcription.label")}
                subtitle={t("settings.transcription.helper")}
                on={eff.transcription_enabled}
                onToggle={() => writePref("transcription_enabled", !eff.transcription_enabled, () => setTranscriptionEnabled(!eff.transcription_enabled))}
                testId="settings.transcription-toggle"
              />
            </Group>
            {/* Directly after screen-capture protection rather than beside the
                lock timers (myne-md/myne#411): both answer the same question,
                which is what somebody holding this phone can see. Its own card
                because its two bounds are always-visible sentences under the
                row, not a subtitle — see the block for why they are not behind
                a chevron. */}
            <HideVaultNamesBlock />
            <SegmentBlock
              label={t("settings.privacy.autoLockAfter")}
              options={[60, 300, 900, 1800, 3600]}
              labels={[t("settings.privacy.autoLock1m"), t("settings.privacy.autoLock5m"), t("settings.privacy.autoLock15m"), t("settings.privacy.autoLock30m"), t("settings.privacy.autoLock1h")]}
              value={eff.auto_lock_seconds ?? 300}
              onPick={(v) => writePref("auto_lock_seconds", v, () => setAutoLockTimeout(v))}
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
                writePref("reminders_enabled", next, () => setRemindersEnabled(next))
              }
            />
            {eff.reminders_enabled && <ExactAlarmBlock />}
          </div>
        )}

        {panel === "data" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
            <Group>
              <ToggleRow
                first
                title={t("settings.attachmentCompression.label")}
                subtitle={t("settings.attachmentCompression.helper")}
                on={eff.attachment_compression_enabled}
                onToggle={() => writePref("attachment_compression_enabled", !eff.attachment_compression_enabled, () => setAttachmentCompressionEnabled(!eff.attachment_compression_enabled))}
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

        {panel === "sync" && (
          <SyncHubPanel
            status={syncStatus}
            onSyncNow={syncNow}
            syncing={syncBusy}
            onOpenEndpoint={() => setPanel("sync-endpoint")}
            onOpenEnroll={() => setPanel("sync-enroll")}
            onOpenDevices={() => setPanel("sync-devices")}
          />
        )}

        {panel === "sync-endpoint" && <SyncEndpointPanel />}

        {panel === "sync-enroll" && <SyncEnrollPanel onEnrolled={() => setPanel("sync")} />}

        {panel === "sync-devices" && <SyncDevicesPanel />}

        {panel === "about" && (
          <div style={{ marginTop: 4 }}>
            <Group>
              <Row first>
                <span style={rowLabel}>{t("settings.about.version")}</span>
                <span style={{ fontSize: 16, color: "var(--fg-3)" }}>
                  0.1.0 · {import.meta.env.MODE === "production" ? t("settings.about.buildChannelStable") : t("settings.about.dev")}
                </span>
              </Row>
              <Row>
                <span style={rowLabel}>{t("settings.about.licenseLabel")}</span>
                <span style={{ fontSize: 16, color: "var(--fg-3)" }}>AGPL-3.0</span>
              </Row>
            </Group>

            {/* The published legal documents (myne-ops#15). They open on
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
            <SheetInput value={renameText} onChange={setRenameText} autoFocus placeholder={VAULT_FALLBACK_LABEL} />
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
                <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
                  {t("settings.quickUnlock.pinSetupHelper")}
                </div>
                <FieldLabel mt={14}>{t("settings.quickUnlock.methodPin")}</FieldLabel>
                <SheetInput type="password" inputMode="numeric" value={pin} onChange={setPin} placeholder={t("settings.quickUnlock.pinPlaceholder6")} />
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
