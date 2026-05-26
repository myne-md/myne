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
import { appDataDir, join } from "@tauri-apps/api/path";
import { Button } from "../primitives/Button";
import { PasswordChangeForm } from "../PasswordChangeForm";
import { DeleteVaultConfirmForm } from "../DeleteVaultConfirmForm";
import { changePassword } from "../../lib/vault-change-password";
import {
  deleteVault,
  mapDeleteVaultError,
  type DeleteVaultPartialFailContext,
  type VaultDeleteError,
} from "../../lib/vault-delete";
import type { VaultChangePasswordError } from "../../types/vault-change-password-error";
import type { StageVaultStatus, SuspicionReason } from "../../lib/stage";

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
   * Parent chain (SettingsModal → Editor → App) dispatches
   * `editor.delete-vault-success`, which transitions Stage to
   * `welcome`. Editor unmounts; SettingsModal unmounts in cascade.
   * The slot is already Empty in both paths (zeroize-before-unlink
   * fires on resolve AND reject), so the transition is consistent
   * with the Rust slot state.
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
      return "Wrong current password or vault file is corrupted.";
    case "SamePasswordRejected":
      return "New password matches the current one.";
    case "WeakNewPassword":
      return "New password must be at least 12 characters.";
    case "IoError":
      return "Disk error, please try again.";
    case "JoinFailure":
      return "Something went wrong, please try again.";
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
  const [view, setView] = useState<View>("idle");
  const [inFlight, setInFlight] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletePartialFail, setDeletePartialFail] =
    useState<DeleteVaultPartialFailContext | null>(null);
  const mountedRef = useRef(true);

  // Defensive guard against state updates after unmount (e.g., the
  // parent modal closes mid-flight via a path that bypasses our
  // in-flight gating). React would warn otherwise.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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
          await deleteVault();
          if (!mountedRef.current) return;
          // Resolve = full success. Slot is Empty + vault dir gone.
          // Notify parent to dispatch `editor.delete-vault-success`;
          // Stage transitions to welcome, Editor unmounts, SettingsModal
          // unmounts in cascade. inFlight clear is harmless because the
          // component is about to unmount.
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

  return (
    <div style={ROOT_STYLE}>
      <section style={SECTION_STYLE}>
        <h3 style={SECTION_HEADING_STYLE}>Argon2id parameters</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <div style={KV_ROW_STYLE}>
            <span style={KV_LABEL_STYLE}>Memory cost</span>
            <span style={KV_VALUE_STYLE}>256 MiB</span>
          </div>
          <div style={KV_ROW_STYLE}>
            <span style={KV_LABEL_STYLE}>Time cost</span>
            <span style={KV_VALUE_STYLE}>3</span>
          </div>
          <div style={KV_ROW_STYLE}>
            <span style={KV_LABEL_STYLE}>Parallelism</span>
            <span style={KV_VALUE_STYLE}>2</span>
          </div>
        </div>
      </section>

      <section style={SECTION_STYLE}>
        <h3 style={SECTION_HEADING_STYLE}>Change password</h3>
        <p style={HELPER_TEXT_STYLE}>
          Rotate your master password while keeping the same vault.
          Recovery phrase stays the same.
        </p>
        <div>
          <Button variant="primary" onClick={() => setView("change-password")}>
            Change password
          </Button>
        </div>
      </section>

      <hr style={DIVIDER_STYLE} aria-hidden="true" />

      <section style={SECTION_STYLE}>
        <h3 style={DANGER_HEADING_STYLE}>Danger zone</h3>
        <p style={HELPER_TEXT_MUTED_STYLE}>
          Permanently delete this vault and all notes. Cannot be undone.
          Recovery phrase will not restore the vault.
        </p>
        <div>
          <Button
            variant="danger"
            onClick={() => {
              setDeletePartialFail(null);
              setView("delete-vault");
            }}
          >
            Delete vault…
          </Button>
        </div>
      </section>
    </div>
  );
}
