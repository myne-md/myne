// Settings → Account panel. Three sub-views driven by local `view` state:
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

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../primitives/Button";
import { PasswordChangeForm } from "../PasswordChangeForm";
import { DeleteVaultConfirmForm } from "../DeleteVaultConfirmForm";
import { changePassword } from "../../lib/vault-change-password";
import { prefsRead, setVaultLabel, setVaultIcon } from "../../lib/prefs";
import { memberVaultStatus } from "../../lib/personAccount";
import { FolderGlyph } from "../../notes/components/FolderGlyph";
import { FOLDER_ICON_NAMES } from "../../notes/folderIcons";
import * as capabilities from "../../platform/capabilities";
import { ConnectedExtensions } from "./ConnectedExtensions";
import { SettingsTopicPanel } from "./SettingsTabs";
import { SettingsSection } from "./SettingsSection";
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

interface AccountPanelProps {
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

// The plain layout wrapper for a section that composes a component which draws
// its own heading (`ConnectedExtensions`), so it needs no seam of its own. Every
// other group in this panel goes through `SettingsSection`.
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
// rejected (`design-notes/security/0491-…`), so this sentence is the whole
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

/** Hover-feedback handlers for an icon-picker tile — deepen its fill + border on
 *  pointer-over so the grid reads as pickable. No-op for the selected tile (it
 *  already carries the accent look) or a disabled grid. */
function iconTileHover(
  selected: boolean,
  disabled: boolean,
): {
  onMouseEnter?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  onMouseLeave?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
} {
  if (selected || disabled) return {};
  return {
    onMouseEnter: (e) => {
      e.currentTarget.style.background = "var(--paper-2)";
      e.currentTarget.style.borderColor = "var(--line-3)";
    },
    onMouseLeave: (e) => {
      e.currentTarget.style.background = "var(--paper)";
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
      return i18n.t("settings.account.changePasswordError.invalidCredentialOrVault");
    case "SamePasswordRejected":
      return i18n.t("settings.account.changePasswordError.samePasswordRejected");
    case "WeakNewPassword":
      return i18n.t("settings.account.changePasswordError.weakNewPassword");
    case "IoError":
      return i18n.t("settings.account.changePasswordError.ioError");
    case "JoinFailure":
      return i18n.t("settings.account.changePasswordError.joinFailure");
    case "ServerAckPending":
      // NOT a failure of the change, and the copy says so first (tasks 41 + 88).
      // The new password works on this device right now; what has not happened
      // is the push, so every other device still holds the old wrap. Saying
      // "couldn't change your password" here would send the user to change it
      // again — and the second change would rewrap the wrap the first one
      // produced, leaving them further from the server, not closer.
      return i18n.t("settings.account.changePasswordError.serverAckPending");
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
      return i18n.t("settings.account.changePasswordError.vaultNotUnlocked");
    case "ChangePasswordInProgress":
      // A second submit while one is in flight. State it rather than swallow it.
      return i18n.t("settings.account.changePasswordError.unexpected");
    default:
      return assertNever(e);
  }
}

function assertNever(x: never): never {
  throw new Error(`[AccountPanel] unhandled error variant: ${JSON.stringify(x)}`);
}

export function AccountPanel({
  vaultId,
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

  // ── The two sub-views, each rendered INSIDE the topic that owns its CTA ────
  //
  // Before the split (myne-md/myne#885) each of these was an early `return`
  // that replaced the whole panel. That cannot survive a topic strip: the strip
  // is rendered by the Settings shell, outside this component, so a sub-view
  // that took the body over would leave the tabs on screen and do nothing when
  // one was clicked. Each form is therefore built here and rendered by the
  // topic that owns the CTA which opens it, which keeps the tab click meaningful
  // and keeps one form and the rows it replaces off the screen at the same time.
  let passwordView: ReactNode = null;
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
                i18n.t("settings.account.changePasswordError.unexpected"),
              );
              if (import.meta.env.DEV) {
                // eslint-disable-next-line no-console
                console.warn("[AccountPanel] change_password rejected:", e);
              }
              return;
          }
        }
      })();
    };

    passwordView = (
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

  let deleteView: ReactNode = null;
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
                "[AccountPanel] delete refused: no resolved active vault id",
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
              "[AccountPanel] vault_delete rejected (UI/router bug indicator):",
              e,
            );
          }
        }
      })();
    };

    deleteView = (
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
      {/* **Vault**: what this vault is called, what it looks like, what can
          reach it, and its password. The change-password CTA and the form it
          opens are one topic body: the form REPLACES the rows beside it rather
          than appearing under them, which is what it did when it took the whole
          panel over.

          Each topic's body keeps the indentation of the code it replaced, the
          convention the AI panel set, so the diff is about which rows moved. */}
      <SettingsTopicPanel panelId="account" topicId="vault">
      {passwordView !== null ? (
        passwordView
      ) : (
        <>
          {/* A member vault has no owner vault password to change: the backend has
              no `root_key` for it and refuses with `VaultNotUnlocked`. The control is
              hidden entirely and the member fast-unlock surface (Privacy) is pointed
              at instead, rather than offering a button that silently does nothing
              (myne-md/myne#858). */}
          {memberVault ? (
            <SettingsSection title={t("settings.account.changePasswordHeading")}>
              <p data-testid="settings.member-vault-notice" style={HELPER_TEXT_STYLE}>
                {t("settings.account.memberVaultNotice")}
              </p>
            </SettingsSection>
          ) : (
            <SettingsSection title={t("settings.account.changePasswordHeading")}>
              <p style={HELPER_TEXT_STYLE}>{t("settings.account.changePasswordHelper")}</p>
              <div>
                <Button
                  variant="primary"
                  data-testid="settings.change-password-cta"
                  // Greyed while a write is in flight, which is the one state the
                  // split newly makes reachable: the danger CTA below is now
                  // clickable from its own topic while this form is open, and a
                  // failed change reported into a form that is no longer the
                  // topic on screen would lose its message.
                  disabled={inFlight}
                  onClick={() => setView("change-password")}
                >
                  {t("settings.account.changePasswordButton")}
                </Button>
              </div>
            </SettingsSection>
          )}

          <SettingsSection title={t("settings.account.sections.identity")}>
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
                {t("settings.account.vaultLabelRenameNotice")}
              </p>
            )}

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

          {/* Browser clipper: absent on web (MYND-574 task 27). A page cannot be a
              native-messaging host, so the extension talks to the desktop app or to
              nothing - there is no degraded mode to offer. Omitted rather than
              disabled: `decisions.md` 2026-07-26 makes that normative. */}
          {capabilities.has("clipper") && (
            <section style={SECTION_STYLE}>
              <ConnectedExtensions />
            </section>
          )}
        </>
      )}
      </SettingsTopicPanel>

      {/* **Danger zone**: the one control here that destroys the vault, on its
          own tab so a reader can reach it without scrolling past the icon
          picker, and so it is not one keystroke from the rows a user opens
          Account to change. The confirmation form replaces the section the same
          way the password form replaces its rows, and the hairline that used to
          separate this region from the one above travels with it. */}
      <SettingsTopicPanel panelId="account" topicId="danger">
      {deleteView !== null ? (
        deleteView
      ) : (
        <>
          {/* The danger zone, and what "danger" means here (MYND-574 task 72).
              Where the local vault may be the only copy it is a destruction; where
              it is a cache of a sync-held vault it is a sign-out that takes this
              browser's copy with it. Same CTA, same testid, same command - different
              promise, because the desktop promise would be false on the other
              client in the direction that loses a user's trust rather than their
              data.

              The section composes the shared treatment (myne-md/myne#885) rather
              than its own red heading and a bare `<hr>`: the hairline above it
              used to be this panel's private divider. The heading keeps its red
              through the treatment's one tone (`tone="danger"`), so the warning
              reads at the heading again rather than being flattened into the
              shared `--fg-3`, and the seam is still the same accent rule every
              other section in the dialog draws. The `variant="danger"` button,
              which is the thing that actually destroys something, and the helper
              text carry the rest. */}
          <SettingsSection
            tone="danger"
            title={
              capabilities.has("localOnlyVault")
                ? t("settings.account.dangerZoneHeading")
                : t("settings.account.localEraseHeading")
            }
          >
            <p style={HELPER_TEXT_MUTED_STYLE}>
              {capabilities.has("localOnlyVault")
                ? t("settings.account.dangerZoneHelper")
                : t("settings.account.localEraseHelper")}
            </p>
            <div>
              <Button
                variant="danger"
                data-testid="settings.delete-vault-cta"
                // Same guard as the change-password CTA, and for the same
                // reason: this section is now reachable from its own topic while
                // the password form sits in the other one, and the form cannot
                // show a failure reported after it stopped being rendered.
                disabled={inFlight}
                onClick={() => {
                  setDeletePartialFail(null);
                  setView("delete-vault");
                }}
              >
                {capabilities.has("localOnlyVault")
                  ? t("settings.account.deleteVaultButton")
                  : t("settings.account.localEraseButton")}
              </Button>
            </div>
          </SettingsSection>
        </>
      )}
      </SettingsTopicPanel>
    </div>
  );
}
