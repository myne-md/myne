// SPDX-License-Identifier: AGPL-3.0
//
// Settings → Privacy → Shared vault unlock. Shown only while a B2B member vault
// is the active vault. A member holds no vault password: their portable
// credential is their own recovery phrase (`vault.member-key`,
// decisions/protocol/0606). This row lets them set a device-local fast
// credential (`vault.member-unlock`) so the vault re-unlocks without retyping the
// 24-word phrase every session: a password, a PIN, or a biometric. The phrase
// stays the portable fallback.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { activeVaultId } from "../../lib/vault-list";
import * as capabilities from "../../platform/capabilities";
import { isMacPlatform } from "../../commands/chord";
import {
  clearMemberUnlock,
  memberUnlockStatus,
  memberVaultStatus,
  setMemberBiometric,
  setMemberPassword,
  setMemberPin,
  type MemberUnlockMethod,
} from "../../lib/personAccount";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { MIN_PASSWORD_LEN, PasswordInput, passwordLength } from "../PasswordInput";
import { SettingRow } from "./SettingRow";
import { HELPER_STYLE } from "./panel-styles";

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
  flexWrap: "wrap" as const,
};

/** Mirror of the Rust `pin::MIN_PIN_LEN`. */
const MIN_PIN_LEN = 6;

export function MemberPasswordSettings() {
  const { t } = useTranslation();
  const [isMember, setIsMember] = useState(false);
  const [configured, setConfigured] = useState<MemberUnlockMethod | null>(null);
  const [editing, setEditing] = useState<"password" | "pin" | null>(null);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [biometricUnavailable, setBiometricUnavailable] = useState(false);

  async function refresh(): Promise<void> {
    const id = await activeVaultId();
    if (!id) return;
    setConfigured((await memberUnlockStatus(id)) ?? null);
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const id = await activeVaultId();
        if (!id) return;
        const member = await memberVaultStatus(id);
        if (!alive) return;
        setIsMember(member === true);
        if (member === true) {
          const m = await memberUnlockStatus(id);
          if (alive) setConfigured(m ?? null);
        }
      } catch {
        if (alive) setIsMember(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!isMember) return null;

  const passwordValid = passwordLength(password) >= MIN_PASSWORD_LEN;
  const pinValid = /^\d+$/.test(pin) && pin.length >= MIN_PIN_LEN;

  async function run(action: () => Promise<void>, tooShort = false): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      setPassword("");
      setPin("");
      setShow(false);
      setEditing(null);
      await refresh();
    } catch (e) {
      const kind = (e as { kind?: string } | null)?.kind;
      setError(
        kind === "BadRequest" || tooShort
          ? i18n.t("settings.memberPassword.errorTooShort", {
              count: editing === "pin" ? MIN_PIN_LEN : MIN_PASSWORD_LEN,
            })
          : i18n.t("settings.memberPassword.errorGeneric"),
      );
    } finally {
      setBusy(false);
    }
  }

  const methodLabel = (m: MemberUnlockMethod): string =>
    m === "biometric"
      ? t("settings.memberPassword.methodBiometric")
      : m === "pin"
        ? t("settings.memberPassword.methodPin")
        : t("settings.memberPassword.methodPassword");

  return (
    <SettingRow
      testId="settings.member-password"
      label={t("settings.memberPassword.title")}
      helperTestId="settings.member-password-status"
      helper={
        configured
          ? t("settings.memberPassword.helperConfigured", { method: methodLabel(configured) })
          : t("settings.memberPassword.helperNotConfigured")
      }
      error={error}
      control={(helperId) => (
        <Button
          variant={configured ? "secondary" : "primary"}
          disabled={busy}
          onClick={() => {
            setError(null);
            setEditing((e) => (e === null ? "password" : null));
          }}
          aria-describedby={helperId}
          data-testid="settings.member-password-set"
        >
          {configured ? t("settings.memberPassword.change") : t("settings.memberPassword.set")}
        </Button>
      )}
    >
      {editing === "password" && (
        <div style={SETUP_STYLE}>
          <PasswordInput
            label={t("settings.memberPassword.label")}
            value={password}
            onChange={(next) => {
              setError(null);
              setPassword(next);
            }}
            show={show}
            onToggleShow={() => setShow((s) => !s)}
            disabled={busy}
            autoFocus
            testId="settings.member-password-input"
          />
          <div style={ACTIONS_STYLE}>
            <Button
              variant="primary"
              disabled={busy || !passwordValid}
              onClick={() => void run(() => setMemberPassword(password))}
              data-testid="settings.member-password-save"
            >
              {t("settings.memberPassword.set")}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setEditing("pin");
                setPassword("");
                setError(null);
              }}
              data-testid="settings.member-password-to-pin"
            >
              {t("settings.memberPassword.usePin")}
            </Button>
            {capabilities.has("biometricQuickUnlock") && isMacPlatform() && !biometricUnavailable && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    try {
                      await setMemberBiometric();
                    } catch (e) {
                      if ((e as { kind?: string } | null)?.kind === "BadRequest") {
                        setBiometricUnavailable(true);
                      }
                      throw e;
                    }
                  })
                }
                data-testid="settings.member-password-biometric"
              >
                {t("settings.memberPassword.useBiometric")}
              </Button>
            )}
          </div>
          <p style={HELPER_STYLE}>{t("settings.memberPassword.setupHelper", { count: MIN_PASSWORD_LEN })}</p>
        </div>
      )}
      {editing === "pin" && (
        <div style={SETUP_STYLE}>
          <Input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => {
              setError(null);
              setPin(e.target.value);
            }}
            placeholder={t("settings.memberPassword.pinPlaceholder", { count: MIN_PIN_LEN })}
            aria-label={t("settings.memberPassword.pinLabel")}
            disabled={busy}
            data-testid="settings.member-pin-input"
          />
          <div style={ACTIONS_STYLE}>
            <Button
              variant="primary"
              disabled={busy || !pinValid}
              onClick={() => void run(() => setMemberPin(pin))}
              data-testid="settings.member-pin-save"
            >
              {t("settings.memberPassword.set")}
            </Button>
          </div>
          <p style={HELPER_STYLE}>{t("settings.memberPassword.pinSetupHelper", { count: MIN_PIN_LEN })}</p>
        </div>
      )}
      {configured && (
        <div style={{ ...ACTIONS_STYLE, marginTop: "var(--space-2)" }}>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void run(() => clearMemberUnlock())}
            data-testid="settings.member-password-remove"
          >
            {t("settings.memberPassword.remove")}
          </Button>
        </div>
      )}
    </SettingRow>
  );
}
