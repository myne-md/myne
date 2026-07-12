import { type ChangeEvent, type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Sheet, Banner, Button, Icon, Toast, StrengthMeter, Switch, Segmented, Spinner } from "../../components";
import { SyncHubPanel, SyncEndpointPanel, SyncEnrollPanel, SyncDevicesPanel } from "../../components";
import { applyTheme } from "../../platform/theme";
import type { ThemeName } from "../../platform/PlatformContext";
import { HAS_TAURI } from "../../lib/app-window";
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
import { useSyncStatus, type SyncStatus } from "../../lib/use-sync-status";
import { ioBanner } from "../../lib/io-banner";
import { usePrefs } from "../../lib/use-prefs";
import { bumpPrefsNonce } from "../../lib/prefsNonce";
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
  setAutoLockTimeout,
  setVaultLabel,
  type PrefsView,
} from "../../lib/prefs";
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

const THEME_CHOICES: { key: ThemeChoice; label: string }[] = [
  { key: "system", label: "System" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "amoled", label: "AMOLED" },
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
 *  editor mount so a returning session respects the saved appearance. */
export function applyStoredTheme(): void {
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
    <div style={{ padding: "12px 14px", border: "1px solid var(--line-1)", borderRadius: 10, background: "var(--bg-1)" }}>
      <div style={{ fontSize: 16, marginBottom: 10, color: "var(--fg-1)" }}>{label}</div>
      <Segmented options={labels} active={active} onChange={(i) => onPick(options[i])} />
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
  // Phase-2 sync (MYND-459): the sync settings panel + its sub-screens.
  | "sync"
  | "sync-endpoint"
  | "sync-enroll"
  | "sync-approve"
  | "sync-devices";

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
  "delete-vault": 2,
  sync: 1,
  "sync-endpoint": 2,
  "sync-enroll": 2,
  "sync-devices": 2,
  "sync-approve": 3,
};

const PANEL_TITLE: Record<Panel, string> = {
  root: "Settings",
  account: "Account",
  appearance: "Appearance",
  editor: "Editor",
  privacy: "Privacy & security",
  data: "Data",
  about: "About",
  rename: "Vault name",
  "change-password": "Change password",
  "quick-unlock": "Quick unlock",
  "delete-vault": "Delete vault",
  sync: "Sync",
  "sync-endpoint": "Sync server",
  "sync-enroll": "Add this device",
  "sync-devices": "Your devices",
  "sync-approve": "Approve device",
};

/** Short, glanceable sync summary for the Settings row value (no wall-clock — SYNC-48). */
function syncSummary(status: SyncStatus | null): string {
  switch (status?.state) {
    case "disabled":
    case undefined:
      return "Off";
    case "not_enrolled":
      return "Not set up";
    case "pending":
      return "Awaiting approval";
    case "idle":
      return "On";
    case "syncing":
      return "Syncing…";
    case "error":
      return "Offline";
    case "conflicts":
      return `${status.count} conflict${status.count === 1 ? "" : "s"}`;
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
  const { biometric, isAndroid } = usePlatform();
  const [panel, setPanel] = useState<Panel>("root");
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredChoice());
  const [toast, setToast] = useState<string | null>(null);
  // Phase-2 sync (MYND-459): honest enrollment status for the Sync section.
  const { status: syncStatus } = useSyncStatus();

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
        setToast(`Exported ${summary.notes} ${summary.notes === 1 ? "note" : "notes"} → ${dest.label}`);
      } else {
        setToast("Export needs the app (not the browser preview).");
      }
    } catch {
      setToast("Couldn't export the vault.");
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

  // ── Vault prefs (Appearance / Editor / Privacy) ────────────────────────────
  const { prefs } = usePrefs();
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
        setToast("Couldn't save that setting");
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
      el.animate(
        [
          { opacity: 0, transform: `translateX(${forward ? "22px" : "-22px"})` },
          { opacity: 1, transform: "translateX(0)" },
        ],
        { duration: 200, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)" },
      );
    }
  }, [panel]);

  function pickTheme(next: ThemeChoice) {
    setChoice(next);
    applyThemeChoice(next);
    if (typeof localStorage !== "undefined") localStorage.setItem(THEME_STORAGE_KEY, next);
    // Persist to vault.prefs too (parity with desktop: theme survives backup /
    // restore and rides sync). localStorage stays the pre-unlock boot cache.
    if (HAS_TAURI) void persistTheme(next === "system" ? null : (next as "light" | "dark" | "amoled")).catch(() => {});
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

  async function submitRename() {
    const label = renameText.trim();
    try {
      if (HAS_TAURI) await setVaultLabel(label.length > 0 ? label : null);
      setDraft((d) => ({ ...d, label: label.length > 0 ? label : null }));
      bumpPrefsNonce();
      setToast("Vault renamed");
      setPanel("account");
    } catch {
      setToast("Couldn't rename the vault");
    }
  }

  async function submitSetupPin() {
    setPinError(null);
    if (pin.length < 6) {
      setPinError("PIN must be at least 6 digits.");
      return;
    }
    if (!/^\d+$/.test(pin)) {
      setPinError("PIN must be digits only.");
      return;
    }
    if (pin !== pinConfirm) {
      setPinError("PINs don't match.");
      return;
    }
    setPinBusy(true);
    try {
      if (HAS_TAURI) await quickUnlockSetupPin(pin);
      setPin("");
      setPinConfirm("");
      refreshQuStatus();
      setToast("PIN quick unlock is on");
      setPanel("privacy");
    } catch (e) {
      const kind = (e as { kind?: string })?.kind;
      setPinError(
        kind === "PinTooShort"
          ? "PIN must be at least 6 digits."
          : kind === "PinNotDigits"
            ? "PIN must be digits only."
            : "Couldn't set up quick unlock.",
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
      setToast("Quick unlock turned off");
      setPanel("privacy");
    } catch {
      setToast("Couldn't turn off quick unlock");
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
      setToast(`${biometric} quick unlock is on`);
    } catch (e) {
      const kind = (e as { kind?: string })?.kind;
      setPinError(
        kind === "HardwareUnavailable"
          ? `${biometric} isn't available on this device.`
          : "Couldn't set up quick unlock.",
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
      setToast("Quick unlock turned off");
    } catch {
      setToast("Couldn't turn off quick unlock");
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
      setPwError("New password must be at least 12 characters.");
      return;
    }
    if (nw !== cf) {
      setPwError("New passwords don't match.");
      return;
    }
    if (nw === cur) {
      setPwError("New password is the same as the current password.");
      return;
    }
    setPwBusy(true);
    try {
      if (HAS_TAURI) await changePassword(cur, nw);
      wipeRef.current();
      setPwBusy(false);
      setToast("Password changed");
      setPanel("account");
    } catch (raw) {
      const e = raw as VaultChangePasswordError;
      switch (e.kind) {
        case "InvalidCredentialOrVault":
          // LITERAL compound (decisions.md 2026-05-02 + 2026-05-06): a single
          // non-distinguishing leg — never collapse to "wrong password" alone.
          setPwError("Wrong current password or vault file is corrupted.");
          break;
        case "WeakNewPassword":
          setPwError("New password must be at least 12 characters.");
          break;
        case "SamePasswordRejected":
          setPwError("New password is the same as the current password.");
          break;
        case "InvalidVaultMeta":
          setPwError("Vault file is unreadable. Restore from a backup.");
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
          setPwError("Something went wrong. Please try again.");
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
      setDeleteError("Couldn't fully delete the vault. Please try again.");
      setDeleteBusy(false);
    }
  }

  // ── Sheet header (title + back/close) ──────────────────────────────────────
  const headerTitle = PANEL_TITLE[panel];

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
            <Icon name="chevron-left" size={18} color="var(--accent)" strokeWidth={2} />
          </button>
        )}
        <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>{headerTitle}</div>
        <button
          onClick={close}
          style={{
            width: 60,
            textAlign: "right",
            border: "none",
            background: "transparent",
            color: "var(--accent)",
            fontSize: 15,
            fontWeight: 600,
            cursor: "pointer",
            padding: 0,
          }}
        >
          Done
        </button>
      </div>

      <div ref={scrollRef} style={{ overflowY: "auto", minHeight: 0 }}>
        {panel === "root" && (
          <>
            <SectionLabel mt={6}>Options</SectionLabel>
            <Group>
              <CategoryRow first glyph="account" label="Account" value={eff.label ?? "Personal"} onClick={() => setPanel("account")} />
              <CategoryRow glyph="appearance" label="Appearance" onClick={() => setPanel("appearance")} />
              <CategoryRow glyph="editor" label="Editor" onClick={() => setPanel("editor")} />
              <CategoryRow
                glyph="privacy"
                label="Privacy & security"
                value={quStatus?.configured && quStatus.method === "pin" ? "PIN" : undefined}
                onClick={() => setPanel("privacy")}
              />
              <CategoryRow glyph="data" label="Data" onClick={() => setPanel("data")} />
              <CategoryRow glyph="sync" label="Sync" value={syncSummary(syncStatus)} onClick={() => setPanel("sync")} />
              <CategoryRow glyph="about" label="About" value="0.1.0" onClick={() => setPanel("about")} />
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
              Lock vault
            </button>

            <SectionLabel>Danger zone</SectionLabel>
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
              Delete vault
            </button>

            <div style={{ marginTop: 16, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)" }}>
              myne · encrypted on this device · open source
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
                <span style={rowLabel}>Vault name</span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 16, color: "var(--fg-3)" }}>{eff.label ?? "Personal"}</span>
                  <RowChevron />
                </span>
              </Row>
              <Row onClick={() => setPanel("change-password")}>
                <span style={rowLabel}>Change password</span>
                <RowChevron />
              </Row>
            </Group>
          </div>
        )}

        {panel === "appearance" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
            <div style={{ padding: "12px 14px", border: "1px solid var(--line-1)", borderRadius: 10, background: "var(--bg-1)" }}>
              <div style={{ fontSize: 16, marginBottom: 10, color: "var(--fg-1)" }}>Theme</div>
              <div style={{ display: "flex", gap: 4, background: "var(--bg-2)", border: "1px solid var(--line-1)", borderRadius: 8, padding: 3 }}>
                {THEME_CHOICES.map((c) => {
                  const on = choice === c.key;
                  return (
                    <div
                      key={c.key}
                      onClick={() => pickTheme(c.key)}
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
                      {c.label}
                    </div>
                  );
                })}
              </div>
            </div>
            <SegmentBlock
              label="Text size"
              options={["sm", "md", "lg", "xl"]}
              labels={["S", "M", "L", "XL"]}
              value={eff.editor_text_size ?? "md"}
              onPick={(v) => writePref("editor_text_size", v, () => setEditorTextSize(v))}
            />
            <SegmentBlock
              label="Editor font"
              options={["mono", "sans"]}
              labels={["Mono", "Sans"]}
              value={eff.editor_font_family ?? "mono"}
              onPick={(v) => writePref("editor_font_family", v, () => setEditorFontFamily(v))}
            />
            <SegmentBlock
              label="Line spacing"
              options={["tight", "normal", "relaxed"]}
              labels={["Tight", "Normal", "Relaxed"]}
              value={eff.editor_line_spacing ?? "normal"}
              onPick={(v) => writePref("editor_line_spacing", v, () => setEditorLineSpacing(v))}
            />
            <Group>
              <ToggleRow
                first
                title="Show edit times"
                subtitle="Timestamps under each note"
                on={eff.show_note_timestamps}
                onToggle={() => writePref("show_note_timestamps", !eff.show_note_timestamps, () => setShowNoteTimestamps(!eff.show_note_timestamps))}
              />
            </Group>
          </div>
        )}

        {panel === "editor" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
            <SegmentBlock
              label="Default view"
              options={["live", "reading", "source"]}
              labels={["Live", "Reading", "Source"]}
              value={eff.editor_default_view_mode ?? "live"}
              onPick={(v) => writePref("editor_default_view_mode", v, () => setEditorDefaultViewMode(v))}
            />
            <Group>
              <ToggleRow
                first
                title="Spell check"
                on={eff.spell_enabled ?? true}
                onToggle={() => writePref("spell_enabled", !(eff.spell_enabled ?? true), () => setSpellEnabled(!(eff.spell_enabled ?? true)))}
              />
              <ToggleRow
                title="Line numbers"
                on={eff.editor_line_numbers ?? false}
                onToggle={() => writePref("editor_line_numbers", !(eff.editor_line_numbers ?? false), () => setEditorLineNumbers(!(eff.editor_line_numbers ?? false)))}
              />
              <ToggleRow
                title="Typewriter scrolling"
                subtitle="Keep the caret vertically centered"
                on={eff.editor_focus_typewriter ?? false}
                onToggle={() => writePref("editor_focus_typewriter", !(eff.editor_focus_typewriter ?? false), () => setEditorFocusTypewriter(!(eff.editor_focus_typewriter ?? false)))}
              />
              <ToggleRow
                title="Dim inactive lines"
                on={eff.editor_focus_dim_inactive ?? false}
                onToggle={() => writePref("editor_focus_dim_inactive", !(eff.editor_focus_dim_inactive ?? false), () => setEditorFocusDimInactive(!(eff.editor_focus_dim_inactive ?? false)))}
              />
              <ToggleRow
                title="Enable archiving"
                on={!(eff.archive_disabled ?? false)}
                onToggle={() => {
                  const nextDisabled = !(eff.archive_disabled ?? false);
                  writePref("archive_disabled", nextDisabled, () => setArchiveDisabled(nextDisabled));
                }}
              />
            </Group>
          </div>
        )}

        {panel === "privacy" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
            <Group>
              <ToggleRow
                first
                title="Screen-capture protection"
                subtitle="Block screenshots and screen recording"
                on={eff.screen_capture_protection}
                onToggle={() => writePref("screen_capture_protection", !eff.screen_capture_protection, () => setScreenCaptureProtection(!eff.screen_capture_protection))}
              />
            </Group>
            <SegmentBlock
              label="Auto-lock after"
              options={[60, 300, 900, 1800, 3600]}
              labels={["1m", "5m", "15m", "30m", "1h"]}
              value={eff.auto_lock_seconds ?? 300}
              onPick={(v) => writePref("auto_lock_seconds", v, () => setAutoLockTimeout(v))}
            />
            <Group>
              <Row first onClick={() => setPanel("quick-unlock")} testId="settings.quick-unlock-row">
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={rowLabel}>Quick unlock</span>
                  <span style={{ fontSize: 13, color: "var(--fg-3)" }}>
                    {isAndroid ? "Re-enter with a PIN after auto-lock" : `Re-enter with ${biometric} or a PIN after auto-lock`}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 15, color: "var(--fg-3)" }} data-testid="settings.quick-unlock-value">
                    {quStatus?.configured ? (quStatus.method === "pin" ? "PIN" : biometric) : "Off"}
                  </span>
                  <RowChevron />
                </div>
              </Row>
            </Group>
          </div>
        )}

        {panel === "data" && (
          <div style={{ marginTop: 4 }}>
            <Group>
              <Row first onClick={exporting ? undefined : () => void runExport()}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={rowLabel}>Export to Markdown</span>
                  <span style={{ fontSize: 13, color: "var(--fg-3)" }}>
                    Decrypt every note to a plain folder in Documents
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
                <span style={rowLabel}>Version</span>
                <span style={{ fontSize: 16, color: "var(--fg-3)" }}>
                  0.1.0 · {import.meta.env.MODE === "production" ? "Stable" : "Dev"}
                </span>
              </Row>
              <Row>
                <span style={rowLabel}>License</span>
                <span style={{ fontSize: 16, color: "var(--fg-3)" }}>AGPL-3.0</span>
              </Row>
            </Group>

            <div style={{ marginTop: 16, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)" }}>
              myne · encrypted on this device · open source
            </div>
          </div>
        )}

        {panel === "rename" && (
          <div>
            <FieldLabel mt={4}>Vault name</FieldLabel>
            <SheetInput value={renameText} onChange={setRenameText} autoFocus placeholder="Personal" />
            <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
              Shown in the vault switcher. Stored encrypted inside this vault; leave blank to clear it.
            </div>
            <div style={{ marginTop: 18 }}>
              <Button onClick={submitRename}>Save</Button>
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
              A convenience gate only. Your password is still required after a restart.
            </div>
            {!isAndroid && (
              <div style={{ marginTop: 12 }}>
                <Group>
                  <ToggleRow
                    first
                    title={biometric}
                    subtitle={`Unlock with ${biometric} after auto-lock`}
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
                  PIN quick unlock is <strong style={{ color: "var(--fg-1)" }}>on</strong>. After the vault
                  auto-locks you can re-enter with your PIN instead of the full password — this app session
                  only. A cold start always requires the full password.
                </div>
                <div style={{ marginTop: 18 }}>
                  <Button variant="danger" onClick={disableQuickUnlock} disabled={pinBusy}>
                    Turn off PIN
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
                  Set a 6+ digit PIN to re-unlock quickly after auto-lock. The PIN wraps a device-local key —
                  it never leaves this device and never touches your recovery phrase.
                  {quStatus?.method === "biometric" && ` Setting a PIN replaces ${biometric} unlock.`}
                </div>
                <FieldLabel mt={14}>PIN</FieldLabel>
                <SheetInput type="password" inputMode="numeric" value={pin} onChange={setPin} placeholder="At least 6 digits" />
                <FieldLabel mt={12}>Confirm PIN</FieldLabel>
                <SheetInput type="password" inputMode="numeric" value={pinConfirm} onChange={setPinConfirm} placeholder="Re-enter PIN" />
                <div style={{ marginTop: 18 }}>
                  <Button onClick={submitSetupPin} disabled={pinBusy}>
                    Set up quick unlock
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
            <FieldLabel mt={pwError ? 10 : 4}>Current password</FieldLabel>
            <SheetInput type="password" value={currentPw} onChange={setCurrentPw} autoFocus placeholder="Current password" />
            <FieldLabel mt={16}>New password</FieldLabel>
            <SheetInput type="password" value={newPw} onChange={setNewPw} placeholder="At least 12 characters" />
            {newPw.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <StrengthMeter level={strengthLevel(newPw.length)} />
              </div>
            )}
            <FieldLabel mt={16}>Confirm new password</FieldLabel>
            <SheetInput type="password" value={confirmPw} onChange={setConfirmPw} placeholder="Re-enter new password" />
            <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
              This invalidates quick-unlock. Your recovery phrase is unchanged.
            </div>
            <div style={{ marginTop: 18 }}>
              <Button onClick={submitChangePassword} disabled={pwBusy}>
                {pwBusy ? "Changing…" : "Change password"}
              </Button>
            </div>
          </div>
        )}

        {panel === "delete-vault" && (
          <div>
            <Banner kind="danger" style={{ marginBottom: 14 }}>
              This permanently deletes this vault and all of its notes from this device. This cannot be undone.
            </Banner>
            {deleteError && (
              <Banner kind="danger" style={{ marginBottom: 14 }}>
                {deleteError}
              </Banner>
            )}
            <FieldLabel mt={0}>Type DELETE to confirm</FieldLabel>
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
                {deleteBusy ? "Deleting…" : "Delete this vault"}
              </button>
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 92, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
          <Toast icon="check">{toast}</Toast>
        </div>
      )}
        </>
      )}
    </Sheet>
  );
}
