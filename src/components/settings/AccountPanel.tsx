// Settings → Account panel. Three sub-views driven by local `view` state:
//
//   - "idle" — Argon2id parameters readout, Change password CTA, Danger
//     zone with active Delete vault button (MYND-105 backend + MYND-108
//     frontend both shipped).
//   - "change-password" — `<PasswordChangeForm>` replaces the panel;
//     Cancel returns to idle; Submit calls `vault_change_password` IPC.
//   - "delete-vault" — `<DeleteVaultConfirmForm>` replaces the panel;
//     Cancel returns to idle (idle-mode only); Submit calls
//     `vault_delete` IPC. On Ok → fires `onDeleteVaultSuccess()` →
//     Stage transitions to welcome (App-level dispatch). On
//     `PartialDelete`/`Io` → form switches to post-fail mode + Continue
//     button (same terminal effect as Ok).
//
// Penpot canon:
//   - idle: `🔴 screen------settings--account`
//   - change-password: `🔴 screen------settings--account--change-password`
//   - delete-vault idle: `screen------settings--account--delete-vault`
//   - delete-vault post-fail: `screen------settings--account--delete-vault--partial-fail` / `--io-error`
//
// In-flight gating: during the Argon2id window the form disables itself
// AND raises `onInFlightChange(true)` so SettingsModal can gate Esc /
// backdrop / ×. The BottomBar Lock button stays enabled — firing
// vault_lock during in-flight is the canonical graceful-cancel path
// (backend returns `VaultLockedDuringChange` → suspicion banner via
// `onForceRelock`). The same `onInFlightChange` chain covers
// vault_delete (sub-second IPC window — Esc / backdrop / × gated).
//
// Memory hygiene: on success / cancel, the relevant form unmounts,
// which clears its fields by component-lifecycle teardown. The
// load-bearing wipe is Rust-side `Zeroizing<String>` (change-password)
// or `take_and_run_blocking` slot zeroize-before-unlink (vault_delete);
// V8 cleanup here is best-effort.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { appDataDir, join } from "@tauri-apps/api/path";
import { Button } from "../primitives/Button";
import { PasswordChangeForm } from "../PasswordChangeForm";
import { DeleteVaultConfirmForm } from "../DeleteVaultConfirmForm";
import { changePassword } from "../../lib/vault-change-password";
import { prefsRead, setVaultLabel, setVaultIcon } from "../../lib/prefs";
import { listVaults, orderByLastUnlock } from "../../lib/vault-list";
import { FolderGlyph } from "../../notes/components/FolderGlyph";
import { FOLDER_ICON_NAMES } from "../../notes/folderIcons";
import { ConnectedExtensions } from "./ConnectedExtensions";
import {
  deleteVault,
  mapDeleteVaultError,
  type DeleteVaultPartialFailContext,
  type VaultDeleteError,
} from "../../lib/vault-delete";
import type { VaultChangePasswordError } from "../../types/vault-change-password-error";
import type { StageVaultStatus, SuspicionReason } from "../../lib/stage";
import i18n from "../../i18n";

interface AccountPanelProps {
  /**
   * Fired after a successful change-password IPC. Parent
   * (SettingsModal) responds by closing the modal and emitting a
   * post-event toast. The success signal is one-shot — AccountPanel
   * does NOT call this on rejection or cancellation.
   */
  onChangePasswordSuccess: () => void;
  /**
   * Fired after a successful `vault_delete` IPC OR after the user
   * clicks Continue on the post-fail banner (PartialDelete / Io).
   * Parent chain (SettingsModal → Editor → App) triggers a
   * `reprobe()`; boot routing then selects the return surface by
   * remaining vault count (picker at ≥2, unlock at 1, welcome at 0).
   * Editor unmounts; SettingsModal unmounts in cascade. The slot is
   * already Empty in both paths (zeroize-before-unlink fires on
   * resolve AND reject), so the reprobe reads consistent state.
   */
  onDeleteVaultSuccess: () => void;
  /**
   * Notify parent when an in-flight Argon2id-bound IPC starts/ends.
   * Parent (SettingsModal) uses this to gate Esc / backdrop / ×
   * dismissal during the ~1-3s window. Optional — when omitted, the
   * parent's gating is unaffected (but the form's own internal
   * disabling still applies). Same chain covers vault_delete's
   * sub-second IPC window.
   */
  onInFlightChange?: (busy: boolean) => void;
  /**
   * Out-of-band Stage set for change-password force-relock paths.
   * Threaded from SettingsModal → Editor → App.tsx's
   * `setStageWithSuspicion` callback. AccountPanel calls this when
   * the IPC rejects with `InvalidVaultMeta`,
   * `VaultMetaChangedExternally`, or `VaultLockedDuringChange` —
   * each maps to a specific (status, reason) tuple per
   * `decisions.md` 2026-05-08 `Stage.unlock.suspicionReason?`
   * entry. Modal closes via Editor unmount cascade after dispatch.
   */
  onForceRelock?: (status: StageVaultStatus, reason?: SuspicionReason) => void;
}

const SECTION_HEADING_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "var(--tracking-caps)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  margin: 0,
};

const DANGER_HEADING_STYLE: CSSProperties = {
  ...SECTION_HEADING_STYLE,
  color: "var(--danger)",
};

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  alignSelf: "stretch",
};

const HELPER_TEXT_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
  margin: 0,
};

const HELPER_TEXT_MUTED_STYLE: CSSProperties = {
  ...HELPER_TEXT_STYLE,
  color: "var(--fg-3)",
};

// VAULT LABEL section (MYND-205 task 6). Pinned to the Penpot spec rather
// than the panel's semantic-token helpers so the eyebrow / input / Save button
// match the rename-control frame exactly (Inter 11/600 eyebrow, 36px controls).
const LABEL_EYEBROW_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  margin: 0,
};

const LABEL_HELPER_STYLE: CSSProperties = {
  fontSize: 13,
  fontWeight: 400,
  lineHeight: "var(--leading-normal)",
  color: "var(--ink-2)",
  margin: 0,
};

const LABEL_INPUT_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: 8,
  alignSelf: "stretch",
};

function labelInputStyle(focused: boolean): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    height: 36,
    boxSizing: "border-box",
    padding: "0 10px",
    background: "var(--paper)",
    border: `1px solid ${focused ? "var(--accent)" : "var(--line-2)"}`,
    borderRadius: "var(--radius-1)",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    color: "var(--ink-1)",
    outline: "none",
  };
}

function labelSaveButtonStyle(disabled: boolean): CSSProperties {
  return {
    height: 36,
    boxSizing: "border-box",
    padding: "0 14px",
    flexShrink: 0,
    background: disabled ? "var(--paper-2)" : "var(--accent)",
    border: `1px solid ${disabled ? "var(--line-1)" : "var(--accent)"}`,
    borderRadius: "var(--radius-2)",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    fontWeight: 500,
    color: disabled ? "var(--line-3)" : "var(--accent-on)",
    cursor: disabled ? "default" : "pointer",
  };
}

// VAULT ICON picker grid (vault-icons) — a curated glyph grid mirroring the
// folder-icon picker (DecorationPopover), laid out inline in the panel.
const ICON_PICKER_LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  margin: 0,
};

const ICON_PICKER_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(9, 1fr)",
  gap: 6,
  alignSelf: "stretch",
};

function iconPickerButtonStyle(
  selected: boolean,
  disabled: boolean,
): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    aspectRatio: "1 / 1",
    boxSizing: "border-box",
    padding: 0,
    background: selected ? "var(--paper-2)" : "var(--paper)",
    border: `1px solid ${selected ? "var(--accent)" : "var(--line-2)"}`,
    borderRadius: "var(--radius-1)",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    fontWeight: 600,
    color: selected ? "var(--accent)" : "var(--ink-1)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}

const KV_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "baseline",
  gap: "var(--space-4)",
};

const KV_LABEL_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  color: "var(--fg-2)",
  width: 140,
  flexShrink: 0,
};

const KV_VALUE_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-mono)",
};

const ROOT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
  alignSelf: "flex-start",
  width: "100%",
};

const DIVIDER_STYLE: CSSProperties = {
  height: 1,
  background: "var(--line-1)",
  border: 0,
  margin: 0,
  alignSelf: "stretch",
};

type View = "idle" | "change-password" | "delete-vault";

/**
 * Map a `VaultChangePasswordError` to the form-level banner copy.
 * Returns `null` for variants that don't render a banner — either they
 * route through force-relock (handled by the caller's switch) or
 * they're UI/router bug indicators that shouldn't reach the user.
 *
 * LITERAL copy pinned by `decisions.md` 2026-05-02 + 2026-05-06.
 * `InvalidCredentialOrVault` is the non-distinguishing wrong-current /
 * tampered-password-section compound — abbreviating it would let a user
 * mistake a corrupted vault for a forgotten password and exhaust their
 * attempts before realizing they should restore from backup.
 */
function mapChangePasswordError(
  e: VaultChangePasswordError,
): string | null {
  switch (e.kind) {
    case "InvalidCredentialOrVault":
      return i18n.t("settings.account.changePasswordError.invalidCredentialOrVault");
    case "SamePasswordRejected":
      return i18n.t("settings.account.changePasswordError.samePasswordRejected");
    case "WeakNewPassword":
      return i18n.t("settings.account.changePasswordError.weakNewPassword");
    case "IoError":
      return i18n.t("settings.account.changePasswordError.ioError");
    case "JoinFailure":
      return i18n.t("settings.account.changePasswordError.joinFailure");
    case "InvalidVaultMeta":
    case "VaultMetaChangedExternally":
    case "VaultLockedDuringChange":
      // Force-relock variants — caller's switch dispatches via
      // `onForceRelock`. No form-level banner.
      return null;
    case "ChangePasswordInProgress":
    case "VaultNotUnlocked":
      // UI/router bug indicators — not user-facing.
      return null;
    default:
      return assertNever(e);
  }
}

function assertNever(x: never): never {
  throw new Error(`[AccountPanel] unhandled error variant: ${JSON.stringify(x)}`);
}

export function AccountPanel({
  onChangePasswordSuccess,
  onDeleteVaultSuccess,
  onInFlightChange,
  onForceRelock,
}: AccountPanelProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("idle");
  const [inFlight, setInFlight] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletePartialFail, setDeletePartialFail] =
    useState<DeleteVaultPartialFailContext | null>(null);
  const mountedRef = useRef(true);

  // VAULT LABEL rename control (MYND-205 task 6). `savedLabel` is the
  // last-persisted label (read from vault.prefs on mount; `""` when unset),
  // `labelDraft` is the live input. Unlock-gated by construction — Settings
  // mounts only when the active vault is unlocked, so `prefs_read` /
  // `vault_set_label` always have the slot's `prefs_key`.
  const [savedLabel, setSavedLabel] = useState<string>("");
  const [labelDraft, setLabelDraft] = useState<string>("");
  const [labelInFlight, setLabelInFlight] = useState(false);
  const [labelFocused, setLabelFocused] = useState(false);

  // VAULT ICON picker (vault-icons). `savedIcon` mirrors the last-persisted
  // `vault.prefs.icon` (`null` ≡ the neutral "M" wordmark); `iconInFlight` gates
  // the grid while a write is in progress. Twin of the label control — same
  // unlock-gated-by-construction contract (Settings mounts only when the active
  // vault is unlocked).
  const [savedIcon, setSavedIcon] = useState<string | null>(null);
  const [iconInFlight, setIconInFlight] = useState(false);

  // Active vault id (MYND-205 task 7). The Settings danger-zone delete targets
  // the vault you currently have unlocked — under SYNC-1 that's the lone
  // `Unlocked` slot, surfaced by `vault_list()` as the most-recent `last_unlock`
  // entry. Resolved on mount and threaded into `deleteVault(activeVaultId)` so
  // the erase is explicitly id-targeted (SYNC-6). `null` until resolved →
  // `deleteVault` falls back to the active vault, identical end state.
  const [activeVaultId, setActiveVaultId] = useState<string | null>(null);

  // Defensive guard against state updates after unmount (e.g., the
  // parent modal closes mid-flight via a path that bypasses our
  // in-flight gating). React would warn otherwise.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load the active vault's current label once on mount. Failure (should not
  // happen on the unlocked editor stage) leaves the draft empty.
  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((prefs) => {
        if (cancelled) return;
        const current = prefs.label ?? "";
        setSavedLabel(current);
        setLabelDraft(current);
        setSavedIcon(prefs.icon);
      })
      .catch(() => {
        /* unlocked-stage read should not reject; leave the draft empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve the active vault id (most-recent `last_unlock`) for the id-targeted
  // danger-zone delete (task 7). Best-effort — on failure `activeVaultId` stays
  // null and `deleteVault` falls back to the active vault.
  useEffect(() => {
    let cancelled = false;
    void listVaults()
      .then((res) => {
        if (cancelled || !("ok" in res) || res.ok.length === 0) return;
        // The active vault is the most-recent last-unlock (SYNC-1/7) — the head
        // of the shared canonical ordering the picker + switcher also use.
        const active = orderByLastUnlock(res.ok)[0];
        setActiveVaultId(active.id);
      })
      .catch(() => {
        /* leave activeVaultId null → deleteVault active-vault fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Propagate in-flight state to the parent so SettingsModal can
  // gate its dismiss handlers per Q9.
  useEffect(() => {
    onInFlightChange?.(inFlight);
  }, [inFlight, onInFlightChange]);

  if (view === "change-password") {
    const handleSubmit = (currentPassword: string, newPassword: string) => {
      setInFlight(true);
      // Clear any prior form-level error before the new attempt.
      // The error will be replaced (set anew) or cleared (on success
      // → unmount) depending on the IPC outcome.
      setFormError(null);
      void (async () => {
        try {
          await changePassword(currentPassword, newPassword);
          if (!mountedRef.current) return;
          // Success: clear in-flight, return to idle (which unmounts
          // PasswordChangeForm and clears its three fields by
          // component-lifecycle teardown), then notify parent to
          // close the modal + emit the success toast.
          setInFlight(false);
          setView("idle");
          onChangePasswordSuccess();
        } catch (raw) {
          if (!mountedRef.current) return;
          setInFlight(false);
          const e = raw as VaultChangePasswordError;
          const banner = mapChangePasswordError(e);
          if (banner !== null) {
            setFormError(banner);
            return;
          }
          // Force-relock variants route through `onForceRelock`
          // (App.tsx's setStageWithSuspicion). Per-variant routing
          // rationale: `decisions.md` 2026-05-08
          // `Stage.unlock.suspicionReason?`. `InvalidVaultMeta` lands
          // on the corrupted-vault fail-closed UI, which is a
          // different UX category from suspicion (no banner).
          switch (e.kind) {
            case "InvalidVaultMeta":
              onForceRelock?.({ kind: "Corrupted" });
              return;
            case "VaultMetaChangedExternally":
              onForceRelock?.(
                { kind: "Exists" },
                "vault-meta-changed-externally",
              );
              return;
            case "VaultLockedDuringChange":
              onForceRelock?.(
                { kind: "Exists" },
                "vault-locked-during-change",
              );
              return;
            default:
              // ChangePasswordInProgress / VaultNotUnlocked are
              // UI/router bug indicators — not user-facing.
              if (import.meta.env.DEV) {
                // eslint-disable-next-line no-console
                console.warn(
                  "[AccountPanel] change_password rejected (UI/router bug indicator):",
                  e,
                );
              }
              return;
          }
        }
      })();
    };

    return (
      <PasswordChangeForm
        onSubmit={handleSubmit}
        onCancel={() => {
          setFormError(null);
          setView("idle");
        }}
        inFlight={inFlight}
        error={formError}
      />
    );
  }

  if (view === "delete-vault") {
    const handleDeleteSubmit = () => {
      setInFlight(true);
      void (async () => {
        try {
          // Id-targeted erase of the active vault (SYNC-6); `?? undefined`
          // falls back to the active-vault path if the id has not resolved yet.
          await deleteVault(activeVaultId ?? undefined);
          if (!mountedRef.current) return;
          // Resolve = full success. Slot is Empty + vault dir gone.
          // Notify parent to reprobe; boot routing picks the return
          // surface by remaining vault count (picker/unlock/welcome),
          // Editor unmounts, SettingsModal unmounts in cascade. inFlight
          // clear is harmless because the component is about to unmount.
          setInFlight(false);
          onDeleteVaultSuccess();
        } catch (raw) {
          if (!mountedRef.current) return;
          setInFlight(false);
          const e = raw as VaultDeleteError;
          // Resolve the vault path lazily on reject — the success
          // path doesn't need it. UI-side resolution mirrors the
          // backend's `paths::vault_dir` derivation.
          const base = await appDataDir();
          const vaultDirPath = await join(base, "vault");
          if (!mountedRef.current) return;
          const mapping = mapDeleteVaultError(e, vaultDirPath);
          if (mapping.kind === "partial-fail") {
            setDeletePartialFail(mapping.context);
            return;
          }
          // Bug-canary: VaultBusyAuth / VaultNotUnlocked /
          // VaultNotFound. No banner. Dev-only warn so the underlying
          // routing bug surfaces in development.
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn(
              "[AccountPanel] vault_delete rejected (UI/router bug indicator):",
              e,
            );
          }
        }
      })();
    };

    return (
      <DeleteVaultConfirmForm
        onSubmit={handleDeleteSubmit}
        onCancel={() => {
          setView("idle");
        }}
        onContinueAfterPartial={() => {
          // Same terminal effect as the happy-path Submit — slot is
          // already Empty (zeroize-before-unlink fired on the IPC
          // reject path too). Stage transition to welcome.
          setDeletePartialFail(null);
          onDeleteVaultSuccess();
        }}
        inFlight={inFlight}
        partialFailContext={deletePartialFail}
      />
    );
  }

  // Persist the vault label. Empty draft ⇒ clear the label (`null`); a
  // non-empty draft sets it. On success, update `savedLabel` so the Save
  // button re-disables (no unsaved diff); setVaultLabel then dispatches
  // VAULT_PREFS_CHANGED_EVENT so the switcher live-refreshes its chip + rows.
  const trimmedLabel = labelDraft.trim();
  const labelChanged = trimmedLabel !== savedLabel;
  const labelSaveDisabled = !labelChanged || labelInFlight;
  const handleSaveLabel = () => {
    if (labelSaveDisabled) return;
    setLabelInFlight(true);
    void (async () => {
      try {
        await setVaultLabel(trimmedLabel === "" ? null : trimmedLabel);
        if (!mountedRef.current) return;
        setSavedLabel(trimmedLabel);
        // setVaultLabel dispatches VAULT_PREFS_CHANGED_EVENT → the switcher
        // live-refreshes its chip + rows (no explicit re-fetch needed here).
      } catch {
        /* unlocked-stage write should not reject; leave the draft as-is */
      } finally {
        if (mountedRef.current) setLabelInFlight(false);
      }
    })();
  };

  // Persist the vault icon (vault-icons). Selecting the already-active glyph (or
  // "Default" when already icon-less) is a no-op. Optimistic: the grid highlight
  // updates immediately, reverting on the (unexpected) unlocked-stage write
  // rejection. On success setVaultIcon dispatches VAULT_PREFS_CHANGED_EVENT so
  // the switcher live-refreshes its glyph. `null` clears back to the wordmark.
  const handleSelectIcon = (name: string | null) => {
    if (iconInFlight || name === savedIcon) return;
    const prevIcon = savedIcon;
    setIconInFlight(true);
    setSavedIcon(name);
    void (async () => {
      try {
        await setVaultIcon(name);
        // setVaultIcon dispatches VAULT_PREFS_CHANGED_EVENT on success, so the
        // switcher live-refreshes its chip + rows — no explicit re-fetch here.
      } catch {
        if (mountedRef.current) setSavedIcon(prevIcon);
      } finally {
        if (mountedRef.current) setIconInFlight(false);
      }
    })();
  };

  return (
    <div style={ROOT_STYLE}>
      <section style={SECTION_STYLE}>
        <h3 style={SECTION_HEADING_STYLE}>{t("settings.account.argon2idHeading")}</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <div style={KV_ROW_STYLE}>
            <span style={KV_LABEL_STYLE}>{t("settings.account.memoryCost")}</span>
            <span style={KV_VALUE_STYLE}>256 MiB</span>
          </div>
          <div style={KV_ROW_STYLE}>
            <span style={KV_LABEL_STYLE}>{t("settings.account.timeCost")}</span>
            <span style={KV_VALUE_STYLE}>3</span>
          </div>
          <div style={KV_ROW_STYLE}>
            <span style={KV_LABEL_STYLE}>{t("settings.account.parallelism")}</span>
            <span style={KV_VALUE_STYLE}>2</span>
          </div>
        </div>
      </section>

      <section style={SECTION_STYLE}>
        <h3 style={SECTION_HEADING_STYLE}>{t("settings.account.changePasswordHeading")}</h3>
        <p style={HELPER_TEXT_STYLE}>{t("settings.account.changePasswordHelper")}</p>
        <div>
          <Button
            variant="primary"
            data-testid="settings.change-password-cta"
            onClick={() => setView("change-password")}
          >
            {t("settings.account.changePasswordButton")}
          </Button>
        </div>
      </section>

      <section style={SECTION_STYLE}>
        <h3 style={LABEL_EYEBROW_STYLE}>{t("settings.account.vaultLabelEyebrow")}</h3>
        <p style={LABEL_HELPER_STYLE}>{t("settings.account.vaultLabelHelper")}</p>
        <div style={LABEL_INPUT_ROW_STYLE}>
          <input
            className="vault-label-input"
            data-testid="settings.label-input"
            type="text"
            value={labelDraft}
            placeholder={t("settings.account.vaultLabelPlaceholder")}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={labelInFlight}
            onChange={(e) => setLabelDraft(e.target.value)}
            onFocus={() => setLabelFocused(true)}
            onBlur={() => setLabelFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSaveLabel();
              }
            }}
            style={labelInputStyle(labelFocused)}
          />
          <button
            type="button"
            data-testid="settings.label-save"
            onClick={handleSaveLabel}
            disabled={labelSaveDisabled}
            style={labelSaveButtonStyle(labelSaveDisabled)}
          >
            {t("settings.account.vaultLabelSave")}
          </button>
        </div>

        <p style={ICON_PICKER_LABEL_STYLE}>{t("settings.account.vaultIconLabel")}</p>
        <div
          role="radiogroup"
          aria-label={t("settings.account.vaultIconLabel")}
          data-testid="settings.icon-picker"
          style={ICON_PICKER_GRID_STYLE}
        >
          <button
            type="button"
            role="radio"
            aria-checked={savedIcon === null}
            aria-label={t("settings.account.vaultIconDefault")}
            title={t("settings.account.vaultIconDefault")}
            data-testid="settings.icon-option"
            data-icon-name="default"
            disabled={iconInFlight}
            onClick={() => handleSelectIcon(null)}
            style={iconPickerButtonStyle(savedIcon === null, iconInFlight)}
          >
            M
          </button>
          {FOLDER_ICON_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={savedIcon === name}
              aria-label={name}
              title={name}
              data-testid="settings.icon-option"
              data-icon-name={name}
              disabled={iconInFlight}
              onClick={() => handleSelectIcon(name)}
              style={iconPickerButtonStyle(savedIcon === name, iconInFlight)}
            >
              <FolderGlyph name={name} size={16} />
            </button>
          ))}
        </div>
      </section>

      <section style={SECTION_STYLE}>
        <ConnectedExtensions />
      </section>

      <hr style={DIVIDER_STYLE} aria-hidden="true" />

      <section style={SECTION_STYLE}>
        <h3 style={DANGER_HEADING_STYLE}>{t("settings.account.dangerZoneHeading")}</h3>
        <p style={HELPER_TEXT_MUTED_STYLE}>{t("settings.account.dangerZoneHelper")}</p>
        <div>
          <Button
            variant="danger"
            data-testid="settings.delete-vault-cta"
            onClick={() => {
              setDeletePartialFail(null);
              setView("delete-vault");
            }}
          >
            {t("settings.account.deleteVaultButton")}
          </Button>
        </div>
      </section>
    </div>
  );
}
