// Settings → Privacy → Quick unlock (MYND-329).
//
// Opt-in (default OFF) PIN / Touch ID fast re-entry over the auto-lock
// envelope. Quick-unlock is a CONVENIENCE gate (A6) layered over the
// already-encrypted store — it never weakens the zero-knowledge root; the
// master password stays the primary credential. This panel section configures
// it for the active (unlocked) vault.
//
// ⚠️ The Touch ID path is HARDWARE-UNVERIFIED pending a Touch ID device test +
// a primitive review (see `core/.../quick_unlock/apple.rs`). Its helper
// copy says so; do not present it as a trusted gate until verified.

import { useEffect, useState } from "react";
import * as capabilities from "../../platform/capabilities";
import { isMacPlatform } from "../../commands/chord";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import {
  quickUnlockDisable,
  quickUnlockSetupBiometric,
  quickUnlockSetupPin,
  quickUnlockStatus,
  type QuickUnlockStatus,
} from "../../lib/quick-unlock";
import { isQuickUnlockError } from "../../types/quick-unlock-error";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { HELPER_STYLE } from "./panel-styles";

/** Minimum PIN length — mirrors the Rust `pin::MIN_PIN_LEN`. */
const MIN_PIN_LEN = 6;

const SETUP_STYLE = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
};

const ACTIONS_STYLE = {
  display: "flex",
  flexDirection: "row" as const,
  gap: "var(--space-2)",
};

/** Map a rejected IPC error to one line of user-facing copy. Resolves the
 *  message at call time (runtime) so a language switch is reflected, rather
 *  than freezing a module-scope map at the boot language. */
function errorMessage(e: unknown): string {
  if (isQuickUnlockError(e)) {
    switch (e.kind) {
      case "PinTooShort":
        return i18n.t("settings.quickUnlock.errorPinTooShort", {
          count: MIN_PIN_LEN,
        });
      case "PinNotDigits":
        return i18n.t("settings.quickUnlock.errorPinNotDigits");
      case "HardwareUnavailable":
        return i18n.t("settings.quickUnlock.errorHardwareUnavailable");
      case "BiometricAuthFailed":
        return i18n.t("settings.quickUnlock.errorBiometricAuthFailed");
      case "Cancelled":
        return i18n.t("settings.quickUnlock.errorCancelled");
      // Setup and disable take the auth permit now (myne#378). The `default:`
      // copy is "Could not configure quick unlock.", which tells the user to
      // give up on a state that clears in seconds.
      case "VaultBusyAuth":
        return i18n.t("settings.quickUnlock.errorBusy");
      case "NotUnlocked":
        return i18n.t("settings.quickUnlock.errorNotUnlocked");
      // Disable only. The credential file survived its own deletion, so the
      // feature is still on; the copy must not read as "turned off".
      case "WipeFailed":
        return i18n.t("settings.quickUnlock.turnOffError");
      default:
        return i18n.t("settings.quickUnlock.errorGeneric");
    }
  }
  return i18n.t("settings.quickUnlock.errorGeneric");
}

export function QuickUnlockSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<QuickUnlockStatus | null>(null);
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Runtime availability gate (#214). Touch ID is offered only where it can
  // actually work: macOS (the only desktop OS with a provider — Linux/Windows
  // return `HardwareUnavailable`), and NOT once an enrollment attempt has proven
  // it unusable (an unsigned build → `errSecMissingEntitlement`, no hardware, or
  // a biometric set change). Retrying cannot succeed until the build is signed,
  // so a button that just errors again would be a lie.
  //
  // `BiometricAuthFailed` (`errSecAuthFailed`) is deliberately NOT in that list:
  // it often means no fingerprint is enrolled, which the user can fix in System
  // Settings and then retry, so this gate must leave the button visible.
  const [biometricUnavailable, setBiometricUnavailable] = useState(false);

  // Fetch current status on mount. In a non-Tauri context (dev/tests) invoke
  // rejects — treat that as "not configured / unavailable", never throw.
  useEffect(() => {
    let alive = true;
    quickUnlockStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        if (alive) setStatus({ configured: false, method: null, available: false });
      });
    return () => {
      alive = false;
    };
  }, []);

  const configured = status?.configured ?? false;

  async function refresh() {
    try {
      setStatus(await quickUnlockStatus());
    } catch {
      setStatus({ configured: false, method: null, available: false });
    }
  }

  async function onSetupPin() {
    setBusy(true);
    setError(null);
    try {
      await quickUnlockSetupPin(pin);
      setPin("");
      setShowPinSetup(false);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSetupBiometric() {
    setBusy(true);
    setError(null);
    try {
      await quickUnlockSetupBiometric();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
      // Enrollment proved biometric can't work here — hide the affordance for the
      // session rather than keep offering a button that only errors (#214).
      if (isQuickUnlockError(e) && e.kind === "HardwareUnavailable") {
        setBiometricUnavailable(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onDisable() {
    setBusy(true);
    setError(null);
    try {
      await quickUnlockDisable();
      setShowPinSetup(false);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const pinValid = /^\d+$/.test(pin) && pin.length >= MIN_PIN_LEN;

  return (
    <SettingRow
      testId="settings.quick-unlock"
      label={t("settings.quickUnlock.title")}
      helperTestId="settings.quick-unlock-status"
      helper={
        configured
          ? t("settings.quickUnlock.helperConfigured", {
              method:
                status?.method === "biometric"
                  ? t("settings.quickUnlock.methodTouchId")
                  : t("settings.quickUnlock.methodPin"),
            })
          : t("settings.quickUnlock.helperNotConfigured")
      }
      control={(helperId) => (
        <Switch
          checked={configured || showPinSetup}
          onChange={(next) => {
            setError(null);
            if (next) {
              setShowPinSetup(true);
            } else {
              setShowPinSetup(false);
              if (configured) void onDisable();
            }
          }}
          ariaLabel={t("settings.quickUnlock.title")}
          ariaDescribedBy={helperId}
          testId="settings.quick-unlock-toggle"
        />
      )}
    >
      {!configured && showPinSetup && (
        <div style={SETUP_STYLE}>
          <Input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={t("settings.quickUnlock.pinPlaceholder", {
              count: MIN_PIN_LEN,
            })}
            aria-label={t("settings.quickUnlock.pinAriaLabel")}
            data-testid="settings.quick-unlock-pin-input"
          />
          <div style={ACTIONS_STYLE}>
            <Button
              variant="primary"
              disabled={busy || !pinValid}
              onClick={() => void onSetupPin()}
              data-testid="settings.quick-unlock-setup-pin"
            >
              {t("settings.quickUnlock.setPin")}
            </Button>
            {/* Biometric quick-unlock is absent on web (MYND-574 task 27):
                the credential is a Keychain/Keystore item with no browser
                counterpart. The PIN button above STAYS — that path is
                "genuinely portable: Argon2id + three files under one vault
                root, no OS secret involved" (`core-wasm-assessment.md`), which
                is why the two are separate capabilities rather than one. */}
            {capabilities.has("biometricQuickUnlock") &&
              isMacPlatform() &&
              !biometricUnavailable && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void onSetupBiometric()}
                  data-testid="settings.quick-unlock-setup-biometric"
                >
                  {t("settings.quickUnlock.useTouchId")}
                </Button>
              )}
          </div>
          <p style={HELPER_STYLE}>
            {t("settings.quickUnlock.setupHelper")}
          </p>
        </div>
      )}

      {error && (
        <p style={{ ...HELPER_STYLE, color: "var(--danger, #c0392b)" }} role="alert">
          {error}
        </p>
      )}
    </SettingRow>
  );
}
