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

/** The reminder shown while this member has no fast credential at all (myne-md/myne#851
 *  task 9). `--fg-2` and `--text-sm`: it asks, it does not flag, because a member who
 *  joined before the password step shipped has done nothing wrong. */
const REMINDER_STYLE = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  margin: 0,
};

/** Its dismissal: link-shaped, so it does not compete with the Set button. */
const LINK_STYLE = {
  font: "inherit",
  color: "var(--accent)",
  background: "none",
  border: 0,
  padding: 0,
  cursor: "pointer",
} as const;

/** Mirror of the Rust `pin::MIN_PIN_LEN`. */
const MIN_PIN_LEN = 6;

export function MemberPasswordSettings() {
  const { t } = useTranslation();
  const [isMember, setIsMember] = useState(false);
  const [configured, setConfigured] = useState<MemberUnlockMethod | null>(null);
  // Whether the status probe has answered yet. `configured === null` is ALSO the
  // value before it resolves, so the reminder below must not read it as "no method".
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<"password" | "pin" | null>(null);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [biometricUnavailable, setBiometricUnavailable] = useState(false);
  // The once-only reminder that this member has no fast credential (myne-md/myne#851
  // task 9, story 22): a member who accepted before the password step shipped can
  // re-open their vault only with the phrase. Session-scoped, like the roster
  // invitation, and it writes nothing and blocks nothing: the row below it is where
  // they act, and the phrase path stays exactly as it was.
  const [reminderDismissed, setReminderDismissed] = useState(false);

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
          if (alive) {
            setConfigured(m ?? null);
            setLoaded(true);
          }
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
      {/* The reminder (task 9), shown only while NO method exists AND the probe has
          answered: `null` is also the value before `memberUnlockStatus` resolves, so
          without the `loaded` gate this flashed on a vault that does have a password.
          It is copy, not a control; the Set button above is the action. There is no
          phrase arm to fall back on: since myne-md/myne#938 task 12
          (`decisions/protocol/0763`) this device password is the ONLY way into a
          member vault, so the reminder is a prompt rather than a nudge beside a
          working alternative. */}
      {loaded && configured === null && !reminderDismissed ? (
        <p data-testid="settings.member-password-reminder" style={REMINDER_STYLE}>
          {t("settings.memberPassword.reminder")}{" "}
          <Button
            variant="ghost"
            type="button"
            data-testid="settings.member-password-reminder-dismiss"
            onClick={() => setReminderDismissed(true)}
            style={LINK_STYLE}
          >
            {t("settings.memberPassword.reminderDismiss")}
          </Button>
        </p>
      ) : null}
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
