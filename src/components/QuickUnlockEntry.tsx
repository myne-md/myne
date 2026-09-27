// Quick-unlock affordance on the Unlock screen (MYND-329, MYND-558).
//
// The PRIMARY unlock surface whenever quick-unlock is redeemable for the vault:
// a PIN field or a Touch ID button lets the user re-enter after an auto-lock
// without the full master password. Since MYND-558 the password form is no
// longer rendered alongside it — the parent `Unlock` screen puts the password
// behind an "Use password instead" reveal, so exactly one credential is asked
// for at a time. The password path itself is untouched: it stays one click away
// and is the only surface when quick-unlock is not redeemable.
//
// **Controlled, not self-probing.** `Unlock` owns the `quick_unlock_status`
// probe and hands down the resolved `method`, because the parent's whole layout
// hinges on the answer — a child that discovered it for itself would have to
// report it back up, mirror it in local state, and lose it on every unmount.
// This component therefore only redeems. Its one upward signal is
// `onUnavailable`, a genuine event: "the credential I just tried is dead, stop
// offering me."
//
// Spring-loaded gate: on a fresh process (app restart) quick-unlock is
// suppressed until one full-password unlock has happened this session. The
// status call reports `available: false` in that window, so the parent renders
// only the password form on a cold start — the PIN field returns after the
// first full unlock + an auto-lock in the same session. The
// `RequiresFullPassword` / `AttemptsExhausted` / `NotConfigured` arm of
// `handleError` is the redeem-time backstop for the same states, routed to the
// parent through `onUnavailable`.
//
// ⚠️ Touch ID is HARDWARE-UNVERIFIED (see `core/.../quick_unlock/apple.rs`).

import { useState, type CSSProperties, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  quickUnlockWithBiometric,
  quickUnlockWithPin,
  type QuickUnlockMethod,
} from "../lib/quick-unlock";
import { InlineSubmitField } from "./primitives/InlineSubmitField";
import { ctaStyle } from "./primitives/CenteredCard";
import { Spinner } from "./Spinner";
import { isQuickUnlockError } from "../types/quick-unlock-error";

interface QuickUnlockEntryProps {
  /**
   * The vault this Unlock screen targets. Threaded into every quick-unlock IPC
   * call because no vault is unlocked here, so the backend can't infer the
   * target from the active slot — without it, redeem mis-resolves to the wrong
   * directory once more than one vault exists.
   */
  vaultId?: string;
  /** The redeemable method, resolved by the parent's status probe. */
  method: QuickUnlockMethod;
  /** Called on a successful quick-unlock — same effect as a password unlock. */
  onUnlocked: () => void;
  /**
   * The credential just proved unusable (`RequiresFullPassword` /
   * `AttemptsExhausted` / `NotConfigured`). The parent drops to the password
   * form for the rest of the mount; this component is not re-offered.
   */
  onUnavailable: () => void;
}

const WRAP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
};

const HINT_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  textAlign: "center",
};

export function QuickUnlockEntry({
  vaultId,
  method,
  onUnlocked,
  onUnavailable,
}: QuickUnlockEntryProps) {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  function handleError(e: unknown) {
    if (isQuickUnlockError(e)) {
      switch (e.kind) {
        // After a restart / a wipe, quick-unlock is unavailable — fold away and
        // let the parent surface the password form in our place.
        case "RequiresFullPassword":
        case "AttemptsExhausted":
        case "NotConfigured":
        // Same shape, different cause (MYND-628): the OS refused the biometric
        // facility to this process — no hardware, or the build cannot reach the
        // Keychain item at all (`errSecMissingEntitlement`, which an unsigned
        // build always hits). Retrying cannot succeed for as long as this build
        // is running, so a note telling the user to try again would be a lie.
        // Folding away is honest AND non-destructive: the credential is never
        // wiped and no failed attempt is burned (the provider errors before the
        // counter — `quick_unlock_with_dir`), so it works again the moment the
        // user runs a signed build. Which today is nobody on macOS: the released
        // `.dmg` is unsigned too, not just `tauri dev` (docs/threat-model.md §1 A9,
        // myne-md/myne#214), so this arm is the normal macOS outcome rather than a
        // developer-only one.
        case "HardwareUnavailable":
          onUnavailable();
          return;
        case "WrongCredential":
          setNote(
            t("unlock.quickUnlock.wrongCredential", {
              remaining: e.detail.remaining,
            }),
          );
          return;
        case "Cancelled":
          setNote(null);
          return;
        // A host-side invariant, not a credential failure (myne#378): another
        // auth op holds the capacity-1 `auth_permits` semaphore. No attempt was
        // burned and the credential is intact, so keep offering it — folding it
        // away would be wrong, and the `default:` copy ("Quick unlock failed.
        // Use your password.") would tell the user their PIN was rejected.
        //
        // The UI already single-flights, so this is unreachable from this
        // surface; the guard lives in the backend because page context is not
        // trusted.
        case "VaultBusyAuth":
          setNote(t("unlock.errors.inProgress"));
          return;
        default:
          setNote(t("unlock.quickUnlock.failed"));
          return;
      }
    }
    setNote(t("unlock.quickUnlock.failed"));
  }

  async function attemptPin(ev: FormEvent) {
    ev.preventDefault();
    if (busy || pin.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      await quickUnlockWithPin(pin, vaultId);
      onUnlocked();
    } catch (e) {
      setPin("");
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function attemptBiometric() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await quickUnlockWithBiometric(vaultId);
      onUnlocked();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={WRAP_STYLE}
      data-testid="unlock.quick-unlock"
      data-method={method}
      // Mirrors `unlock.form`'s SYNC-8 idiom so the vault-addressed target stays
      // observable on the PIN-primary surface, where no form is rendered.
      data-vault-id={vaultId}
    >
      {method === "biometric" ? (
        <button
          type="button"
          onClick={() => void attemptBiometric()}
          disabled={busy}
          style={ctaStyle(busy)}
          data-testid="unlock.quick-touchid"
        >
          {busy && <Spinner size={14} style={{ borderWidth: 2 }} />}
          <span>
            {busy ? t("unlock.decrypting") : t("unlock.quickUnlock.unlockWithTouchId")}
          </span>
        </button>
      ) : (
        <form onSubmit={attemptPin}>
          {/* The same deboxed row the password takes (myne-md/myne#773). The PIN
              runs the vault's own Argon2id parameters, so it is the same
              multi-second wait, and the field's sweeping rule carries it — which
              is why the two surfaces must not diverge here: a user who swaps
              between them with "Use password instead" would otherwise watch the
              screen change shape for a choice that changes only the credential. */}
          <InlineSubmitField
            value={pin}
            onChange={setPin}
            busy={busy}
            ariaLabel={t("unlock.quickUnlock.pinAriaLabel")}
            placeholder={t("unlock.quickUnlock.pinPlaceholder")}
            submitLabel={t("unlock.quickUnlock.unlockWithPin")}
            busyLabel={t("unlock.decrypting")}
            testId="unlock.quick-pin-input"
            submitTestId="unlock.quick-pin-submit"
            inputProps={{
              type: "password",
              inputMode: "numeric",
              // MYND-558: the PIN is the primary (and only) field on screen when
              // it is offered, so it takes the caret the password input used to
              // hold.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus: true,
              autoComplete: "off",
            }}
          />
        </form>
      )}
      {note != null && (
        <p style={HINT_STYLE} role="alert" data-testid="unlock.quick-note">
          {note}
        </p>
      )}
    </div>
  );
}
