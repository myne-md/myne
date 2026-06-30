import { type ChangeEvent, type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { Sheet, Banner, Button, Icon, Toast, StrengthMeter } from "../../components";
import { applyTheme } from "../../platform/theme";
import type { ThemeName } from "../../platform/PlatformContext";
import { HAS_TAURI } from "../../lib/app-window";
import { changePassword } from "../../lib/vault-change-password";
import { deleteVault } from "../../lib/vault-delete";
import { ioBanner } from "../../lib/io-banner";
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
}: {
  children: ReactNode;
  first?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
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
}: {
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "password";
  placeholder?: string;
  autoFocus?: boolean;
  mono?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
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

// ── SettingsSheet ─────────────────────────────────────────────────────────────

type Panel = "root" | "change-password" | "delete-vault";

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
  const [panel, setPanel] = useState<Panel>("root");
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredChoice());
  const [toast, setToast] = useState<string | null>(null);

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

  const wipeRef = useRef<() => void>(() => {});
  wipeRef.current = () => {
    setCurrentPw("");
    setNewPw("");
    setConfirmPw("");
    setPwError(null);
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

  function pickTheme(next: ThemeChoice) {
    setChoice(next);
    applyThemeChoice(next);
    if (typeof localStorage !== "undefined") localStorage.setItem(THEME_STORAGE_KEY, next);
  }

  function goRoot() {
    wipeRef.current();
    setConfirmText("");
    setDeleteError(null);
    setPanel("root");
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
      setPanel("root");
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
  const headerTitle = panel === "change-password" ? "Change password" : panel === "delete-vault" ? "Delete vault" : "Settings";

  return (
    <Sheet style={{ maxHeight: "88%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 2px 12px" }}>
        {panel === "root" ? (
          <span style={{ width: 60 }} />
        ) : (
          <button
            onClick={goRoot}
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
          onClick={onClose}
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

      <div style={{ overflowY: "auto", minHeight: 0 }}>
        {panel === "root" && (
          <>
            <SectionLabel mt={6}>Account</SectionLabel>
            <Group>
              <Row first>
                <span style={rowLabel}>Vault</span>
                <span style={{ fontSize: 16, color: "var(--fg-3)" }}>Personal</span>
              </Row>
              <Row onClick={() => setPanel("change-password")}>
                <span style={rowLabel}>Change password</span>
                <RowChevron />
              </Row>
            </Group>

            <SectionLabel>Appearance</SectionLabel>
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
              myne 0.1.0 · open source
            </div>
          </>
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
    </Sheet>
  );
}
