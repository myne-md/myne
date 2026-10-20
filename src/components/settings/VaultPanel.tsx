// Settings → Vault panel. Everything that acts on the sealed container itself:
// how it is named and drawn (label, icon), the credential that opens it
// (change password), and its destruction (delete vault / erase this browser's
// copy). Split out of the Account panel, which used to be filled with exactly
// these controls while showing nothing about the account itself.
//
// Three axes meet in Settings and this panel owns one of them: the ACCOUNT is
// the device-local grouping of vaults (Account panel), the VAULT is the sealed
// container (here), and SYNC is how a vault's content moves (Sync panel).
//
// Three sub-views driven by local `view` state:
//
//   - "idle" — Change password CTA, Danger zone with active Delete vault
//     button (MYND-105 backend + MYND-108 frontend both shipped).
//   - "change-password" — `<PasswordChangeForm>` replaces the panel;
//     Cancel returns to idle; Submit calls `vault_change_password` IPC.
//   - "delete-vault" — `<DeleteVaultConfirmForm>` replaces the panel;
//     Cancel returns to idle (idle-mode only); Submit calls
//     `vault_delete` IPC. On Ok → fires `onDeleteVaultSuccess()` →
//     Stage transitions to welcome (App-level dispatch). On
//     `PartialDelete`/`Io` → form switches to post-fail mode + Continue
//     button (same terminal effect as Ok).
//
// Penpot canon: the frames below were drawn before the split and are still
// named `settings--account*` in the file. The design references are those
// names, unchanged; only the rail label moved.
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

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../primitives/Button";
import { SettingsSection } from "./SettingsSection";
import { SettingsTopicPanel } from "./SettingsTabs";
import { interactiveSurface } from "../primitives/interactiveSurface";
import { PasswordChangeForm } from "../PasswordChangeForm";
import { DeleteVaultConfirmForm } from "../DeleteVaultConfirmForm";
import { changePassword } from "../../lib/vault-change-password";
import { prefsRead, setVaultLabel, setVaultIcon } from "../../lib/prefs";
import { memberVaultStatus } from "../../lib/personAccount";
import { FolderGlyph } from "../../notes/components/FolderGlyph";
import { FOLDER_ICON_NAMES } from "../../notes/folderIcons";
import * as capabilities from "../../platform/capabilities";
import {
  deleteVault,
  mapDeleteVaultError,
  vaultDirDisplayPath,
  type DeleteVaultPartialFailContext,
  type VaultDeleteError,
} from "../../lib/vault-delete";
import type { VaultChangePasswordError } from "../../types/vault-change-password-error";
import type { StageVaultStatus, SuspicionReason } from "../../lib/stage";
import i18n from "../../i18n";

interface VaultPanelProps {
  /**
   * The vault this panel acts on — REQUIRED for the danger-zone delete (#250).
   *
   * The panel used to resolve it itself, by ordering `vault_list()` on
   * `last_unlock` and taking the head. That cache is stamped by the
   * password-unlock path only, so after a quick-unlock or a recovery it named a
   * DIFFERENT vault than the open one — and this is the surface that erases it.
   * `null` means "not resolved yet": the delete is refused rather than aimed at
   * a guess.
   */
  vaultId: string | null;
  /**
   * Fired after a successful change-password IPC. Parent
   * (SettingsModal) responds by closing the modal and emitting a
   * post-event toast. The success signal is one-shot — VaultPanel
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
   * `setStageWithSuspicion` callback. VaultPanel calls this when
   * the IPC rejects with `InvalidVaultMeta`,
   * `VaultMetaChangedExternally`, or `VaultLockedDuringChange` —
   * each maps to a specific (status, reason) tuple per
   * `decisions.md` 2026-05-08 `Stage.unlock.suspicionReason?`
   * entry. Modal closes via Editor unmount cascade after dispatch.
   */
  onForceRelock?: (status: StageVaultStatus, reason?: SuspicionReason) => void;
}




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


const LABEL_HELPER_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-regular)",
  lineHeight: "var(--leading-normal)",
  color: "var(--ink-2)",
  margin: 0,
};

const LABEL_INPUT_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-2)",
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
    fontSize: "var(--text-sm)",
    color: "var(--ink-1)",
    outline: "none",
  };
}

// The cross-device staleness notice (myne-md/myne#411), shown while a rename is
// pending. The device-local name cache does not sync: another device keeps
// showing the name IT last decrypted until this vault is unlocked there.
// Clearing on sync-head movement and a fixed expiry were both considered and
// rejected (`docs/decisions/security/0491-…`), so this sentence is the whole
// mitigation for that window rather than a footnote about one.
//
// Marked with a left rule rather than a colour: it is a consequence of the
// action, not a warning about it, and the person most likely to read it is
// renaming precisely to get a name off a screen. Alarm styling would misreport
// a normal outcome (PRODUCT.md).
//
// The rule is `--line-1`, the hairline token. `docs/design/README.md`
// "Borders + dividers" reserves `--line-2` for input borders and hover states,
// and this is neither: it separates a sentence from the control above it.
const LABEL_RENAME_NOTICE_STYLE: CSSProperties = {
  ...LABEL_HELPER_STYLE,
  color: "var(--ink-3)",
  paddingLeft: "var(--space-3)",
  borderLeft: "1px solid var(--line-1)",
};

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
    fontSize: "var(--text-sm)",
    fontWeight: "var(--weight-medium)",
    color: disabled ? "var(--line-3)" : "var(--accent-on)",
    cursor: disabled ? "default" : "pointer",
  };
}

// VAULT ICON picker grid (vault-icons) — a curated glyph grid mirroring the
// folder-icon picker (DecorationPopover), laid out inline in the panel.
const ICON_PICKER_LABEL_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  margin: 0,
};

const ICON_PICKER_GRID_STYLE: CSSProperties = {
  display: "grid",
  // Cap each column so the square tiles stay a fixed, crisp size instead of
  // scaling up with the (now full-window) modal — `minmax(0, 56px)` lets them
  // shrink on a narrow surface but never balloon (#206). `justify-content:
  // start` packs the leftover width to the right so the grid stays tidy.
  gridTemplateColumns: "repeat(9, minmax(0, 56px))",
  justifyContent: "start",
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
    fontSize: "var(--text-sm)",
    fontWeight: "var(--weight-semibold)",
    color: selected ? "var(--accent)" : "var(--ink-1)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
    transition:
      "background var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)",
  };
}

/** Hover and press feedback for an icon-picker tile: deepen its fill and its
 *  border on pointer-over so the grid reads as pickable, and step the fill
 *  further on press so a click is confirmed. No-op for the selected tile (it
 *  already carries the accent look) or a disabled grid.
 *
 *  The fill half comes from `interactiveSurface`, which owns the press step, and
 *  the border change is chained on top of the handlers it returns rather than
 *  spread around them: spreading a helper carrying event props AFTER a
 *  hand-written handler silently replaces it (`src/AGENTS.md`). */
function iconTileHover(
  selected: boolean,
  disabled: boolean,
): {
  onMouseEnter?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  onMouseLeave?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerLeave?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
} {
  if (selected || disabled) return {};
  const surface = interactiveSurface({
    restBg: "var(--paper)",
    hoverBg: "var(--paper-2)",
  });
  return {
    ...surface,
    onMouseEnter: (e) => {
      surface.onMouseEnter?.(e);
      e.currentTarget.style.borderColor = "var(--line-3)";
    },
    onMouseLeave: (e) => {
      surface.onMouseLeave?.(e);
      e.currentTarget.style.borderColor = "var(--line-2)";
    },
  };
}

const ROOT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
  alignSelf: "flex-start",
  width: "100%",
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
      return i18n.t("settings.vault.changePasswordError.invalidCredentialOrVault");
    case "SamePasswordRejected":
      return i18n.t("settings.vault.changePasswordError.samePasswordRejected");
    case "WeakNewPassword":
      return i18n.t("settings.vault.changePasswordError.weakNewPassword");
    case "IoError":
      return i18n.t("settings.vault.changePasswordError.ioError");
    case "JoinFailure":
      return i18n.t("settings.vault.changePasswordError.joinFailure");
    case "ServerAckPending":
      // NOT a failure of the change, and the copy says so first (tasks 41 + 88).
      // The new password works on this device right now; what has not happened
      // is the push, so every other device still holds the old wrap. Saying
      // "couldn't change your password" here would send the user to change it
      // again — and the second change would rewrap the wrap the first one
      // produced, leaving them further from the server, not closer.
      return i18n.t("settings.vault.changePasswordError.serverAckPending");
    case "InvalidVaultMeta":
    case "VaultMetaChangedExternally":
    case "VaultLockedDuringChange":
      // Force-relock variants — caller's switch dispatches via
      // `onForceRelock`. No form-level banner.
      return null;
    case "VaultNotUnlocked":
      // The Rust side returns this whenever the vault slot is not unlocked when
      // the command runs, on any vault, not only a shared one. Never a silent
      // no-op (myne-md/myne#858).
      return i18n.t("settings.vault.changePasswordError.vaultNotUnlocked");
    case "ChangePasswordInProgress":
      // A second submit while one is in flight. State it rather than swallow it.
      return i18n.t("settings.vault.changePasswordError.unexpected");
    default:
      return assertNever(e);
  }
}

function assertNever(x: never): never {
  throw new Error(`[VaultPanel] unhandled error variant: ${JSON.stringify(x)}`);
}

export function VaultPanel({
  vaultId,
  onChangePasswordSuccess,
  onDeleteVaultSuccess,
  onInFlightChange,
  onForceRelock,
}: VaultPanelProps) {
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

  // A member vault holds no owner tier, so `vault_change_password` refuses with
  // `VaultNotUnlocked` at the slot peek. Offering the control anyway made that a
  // silent no-op with the form left open (myne-md/myne#858). Probe the vault's
  // kind once and hide the owner password section for a member.
  const [memberVault, setMemberVault] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!vaultId) return;
      try {
        const member = await memberVaultStatus(vaultId);
        if (alive) setMemberVault(member === true);
      } catch {
        if (alive) setMemberVault(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [vaultId]);

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

  // Propagate in-flight state to the parent so SettingsModal can
  // gate its dismiss handlers per Q9.
  useEffect(() => {
    onInFlightChange?.(inFlight);
  }, [inFlight, onInFlightChange]);

  if (view === "change-password" && !memberVault) {
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
              // Never a silent no-op (myne-md/myne#858): an unexpected refusal
              // leaves the form open with a stated reason rather than nothing.
              setFormError(
                i18n.t("settings.vault.changePasswordError.unexpected"),
              );
              if (import.meta.env.DEV) {
                // eslint-disable-next-line no-console
                console.warn("[VaultPanel] change_password rejected:", e);
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
          // Id-targeted erase (SYNC-6), and the id is REQUIRED since #250:
          // an unresolved target means we do not know which vault the user is
          // looking at, and this button is irreversible. Refuse, do not guess.
          if (vaultId == null) {
            if (import.meta.env.DEV) {
              // eslint-disable-next-line no-console
              console.warn(
                "[VaultPanel] delete refused: no resolved active vault id",
              );
            }
            return;
          }
          await deleteVault(vaultId);
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
          //
          // `null` where the platform has no such path (phase3-web-client task
          // 72). `path.appDataDir` is a typed refusal in the browser seam, and
          // an unguarded call here would throw INSIDE this catch block —
          // swallowing the mapping and leaving the user with a failed delete and
          // no banner at all. The capability is the same one that selects the
          // copy: a client whose vault is not the only copy has no directory to
          // send anyone to either.
          const vaultDirPath = await vaultDirDisplayPath(vaultId);
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
              "[VaultPanel] vault_delete rejected (UI/router bug indicator):",
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
        variant={memberVault ? "member" : "owner"}
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
      {/* **Vault**: what this vault is called, what it looks like, and its
          password (myne-md/myne#885). The panel's two topics split the rows a
          user opens this panel to change from the one control that destroys the
          vault. The password and erase forms still replace the whole panel body
          (the early returns above), so a form never sits beside the rows it
          replaces whichever topic is selected. */}
      <SettingsTopicPanel panelId="vault" topicId="vault">
      {/* A member vault has no owner vault password to change: the backend has
          no `root_key` for it and refuses with `VaultNotUnlocked`. The control is
          hidden entirely and the member fast-unlock surface (Privacy) is pointed
          at instead, rather than offering a button that silently does nothing
          (myne-md/myne#858). */}
      {memberVault ? (
        <SettingsSection title={t("settings.vault.changePasswordHeading")}>
          <p data-testid="settings.member-vault-notice" style={HELPER_TEXT_STYLE}>
            {t("settings.vault.memberVaultNotice")}
          </p>
        </SettingsSection>
      ) : (
        <SettingsSection title={t("settings.vault.changePasswordHeading")}>
          <p style={HELPER_TEXT_STYLE}>{t("settings.vault.changePasswordHelper")}</p>
          <div>
            <Button
              variant="primary"
              data-testid="settings.change-password-cta"
              onClick={() => setView("change-password")}
            >
              {t("settings.vault.changePasswordButton")}
            </Button>
          </div>
        </SettingsSection>
      )}

      <SettingsSection title={t("settings.vault.sections.identity")}>
        <p style={LABEL_HELPER_STYLE}>{t("settings.vault.vaultLabelHelper")}</p>
        <div style={LABEL_INPUT_ROW_STYLE}>
          <input
            className="vault-label-input"
            data-testid="settings.label-input"
            type="text"
            value={labelDraft}
            placeholder={t("settings.vault.vaultLabelPlaceholder")}
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
            {t("settings.vault.vaultLabelSave")}
          </button>
        </div>

        {/*
          Shown while a rename is pending, which is the moment the user can act
          on it: unlock the vault on the other device, or decide what is sitting
          on that lock screen is acceptable. `labelChanged` also covers CLEARING
          the name, and that is the case this exists for -- someone emptying the
          field to get a name off a screen would otherwise be told nothing about
          the copy that stays.

          The gate is deliberately NOT narrowed to "there was a saved label".
          `savedLabel` is this vault's `vault.prefs.label`, which syncs; the
          stored copy on another device does not, so a vault whose label was
          cleared here can still be sitting under its old name over there. A
          gate on `savedLabel !== ""` would go quiet in exactly that case. The
          copy carries the breadth instead: it names what the other devices show
          without asserting that it is a name.
        */}
        {labelChanged && (
          <p
            role="status"
            data-testid="settings.label-rename-notice"
            style={LABEL_RENAME_NOTICE_STYLE}
          >
            {t("settings.vault.vaultLabelRenameNotice")}
          </p>
        )}

        <p style={ICON_PICKER_LABEL_STYLE}>{t("settings.vault.vaultIconLabel")}</p>
        <div
          role="radiogroup"
          aria-label={t("settings.vault.vaultIconLabel")}
          data-testid="settings.icon-picker"
          style={ICON_PICKER_GRID_STYLE}
        >
          <button
            type="button"
            role="radio"
            aria-checked={savedIcon === null}
            aria-label={t("settings.vault.vaultIconDefault")}
            title={t("settings.vault.vaultIconDefault")}
            data-testid="settings.icon-option"
            data-icon-name="default"
            disabled={iconInFlight}
            onClick={() => handleSelectIcon(null)}
            {...iconTileHover(savedIcon === null, iconInFlight)}
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
              {...iconTileHover(savedIcon === name, iconInFlight)}
              style={iconPickerButtonStyle(savedIcon === name, iconInFlight)}
            >
              <FolderGlyph name={name} size={16} />
            </button>
          ))}
        </div>
      </SettingsSection>
      </SettingsTopicPanel>

      {/* **Danger zone**: the one control here that destroys the vault, on its
          own tab so a reader reaches it without scrolling past the icon picker,
          and so it is not one keystroke from the rows a user opens this panel
          to change. The shared section treatment replaces the private heading
          and `<hr>` this region used to draw; the heading keeps its red through
          the treatment's one tone (`tone="danger"`). */}
      <SettingsTopicPanel panelId="vault" topicId="danger">

      {/* The danger zone, and what "danger" means here (MYND-574 task 72).
          Where the local vault may be the only copy it is a destruction; where
          it is a cache of a sync-held vault it is a sign-out that takes this
          browser's copy with it. Same CTA, same testid, same command — different
          promise, because the desktop promise would be false on the other
          client in the direction that loses a user's trust rather than their
          data. */}
      <SettingsSection
        tone="danger"
        title={
          memberVault || capabilities.has("localOnlyVault")
            ? t("settings.vault.dangerZoneHeading")
            : t("settings.vault.localEraseHeading")
        }
      >
        {/* A member vault's copy is not the vault. The owner sentence below
            ("permanently delete ... recovery phrase will not restore") is false
            for a member in the dangerous direction, so it is ABSENT rather than
            corrected: the confirm form carries the shared-vault disclosure
            verbatim, and this section only has to name the action. */}
        {!memberVault && (
          <p style={HELPER_TEXT_MUTED_STYLE}>
            {capabilities.has("localOnlyVault")
              ? t("settings.vault.dangerZoneHelper")
              : t("settings.vault.localEraseHelper")}
          </p>
        )}
        <div>
          <Button
            variant="danger"
            data-testid="settings.delete-vault-cta"
            onClick={() => {
              setDeletePartialFail(null);
              setView("delete-vault");
            }}
          >
            {memberVault
              ? t("settings.deleteVault.memberSubmit")
              : capabilities.has("localOnlyVault")
                ? t("settings.vault.deleteVaultButton")
                : t("settings.vault.localEraseButton")}
          </Button>
        </div>
      </SettingsSection>
      </SettingsTopicPanel>
    </div>
  );
}
