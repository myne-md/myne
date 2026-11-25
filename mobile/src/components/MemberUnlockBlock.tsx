// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared-vault fast-unlock settings block (myne-md/myne#711). Shown only while a
// B2B member vault is the active vault. A member holds no vault password: their
// portable credential is their own recovery phrase (`vault.member-key`,
// decisions/protocol/0606). This block lets them set a device-local fast
// credential (`vault.member-unlock`, decisions/protocol/0653) — a password, a
// PIN, or (on iOS) a biometric — so the vault re-unlocks without retyping the
// 24-word phrase every session. The phrase stays the portable fallback.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MIN_PASSWORD_LEN, passwordLength } from "@myne/client-core/password-policy";
import {
  clearMemberUnlock,
  memberUnlockStatus,
  memberVaultStatus,
  setMemberBiometric,
  setMemberPassword,
  setMemberPin,
  type MemberUnlockMethod,
} from "../lib/personAccount";
import { soleVaultId } from "../lib/vault-list";
import { usePlatform } from "../formfactor/PlatformContext";
import { Button } from "./Button";

/** Mirror of the Rust `pin::MIN_PIN_LEN` / `MIN_PASSWORD_LEN`. */
const MIN_PIN_LEN = 6;

const CARD = {
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-3)",
  background: "var(--bg-2)",
  padding: "var(--space-4)",
  display: "flex",
  flexDirection: "column" as const,
  gap: "var(--space-3)",
};

const INPUT = {
  width: "100%",
  boxSizing: "border-box" as const,
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  background: "var(--bg-1)",
  padding: "var(--space-3) var(--space-4)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
};

export function MemberUnlockBlock() {
  const { t } = useTranslation();
  const { isAndroid } = usePlatform();
  const [isMember, setIsMember] = useState(false);
  const [method, setMethod] = useState<MemberUnlockMethod | null>(null);
  const [editing, setEditing] = useState<"password" | "pin" | null>(null);
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function refresh(id: string): Promise<void> {
    setMethod((await memberUnlockStatus(id)) ?? null);
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const id = await soleVaultId();
        if (!id) return;
        const member = await memberVaultStatus(id);
        if (!alive) return;
        setIsMember(member === true);
        if (member === true) {
          const m = await memberUnlockStatus(id);
          if (alive) setMethod(m ?? null);
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

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(false);
    try {
      const id = await soleVaultId();
      if (!id) return;
      await action();
      setPassword("");
      setPin("");
      setEditing(null);
      await refresh(id);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const methodLabel =
    method === "biometric"
      ? t("settings.memberPassword.methodBiometric")
      : method === "pin"
        ? t("settings.memberPassword.methodPin")
        : t("settings.memberPassword.methodPassword");

  return (
    <div style={CARD} data-testid="settings.member-password">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        <span style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-semibold)", color: "var(--fg-1)" }}>
          {t("settings.memberPassword.title")}
        </span>
        <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }} data-testid="settings.member-password-status">
          {method
            ? t("settings.memberPassword.helperConfigured", { method: methodLabel })
            : t("settings.memberPassword.helperNotConfigured")}
        </span>
      </div>
      {editing === "password" && (
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setError(false);
            setPassword(e.target.value);
          }}
          placeholder={t("settings.memberPassword.label")}
          aria-label={t("settings.memberPassword.label")}
          disabled={busy}
          data-testid="settings.member-password-input"
          style={INPUT}
        />
      )}
      {editing === "pin" && (
        <input
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => {
            setError(false);
            setPin(e.target.value);
          }}
          placeholder={t("settings.memberPassword.pinPlaceholder", { count: MIN_PIN_LEN })}
          aria-label={t("settings.memberPassword.pinLabel")}
          disabled={busy}
          data-testid="settings.member-pin-input"
          style={INPUT}
        />
      )}
      <div style={{ display: "flex", flexDirection: "row", gap: "var(--space-2)", flexWrap: "wrap" }}>
        {editing === "password" ? (
          <Button disabled={busy || !passwordValid} onClick={() => void run(() => setMemberPassword(password))} data-testid="settings.member-password-save">
            {t("settings.memberPassword.set")}
          </Button>
        ) : editing === "pin" ? (
          <Button disabled={busy || !pinValid} onClick={() => void run(() => setMemberPin(pin))} data-testid="settings.member-pin-save">
            {t("settings.memberPassword.set")}
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => { setError(false); setEditing("password"); }} data-testid="settings.member-password-set">
            {method ? t("settings.memberPassword.change") : t("settings.memberPassword.set")}
          </Button>
        )}
        {editing === null && (
          <Button disabled={busy} onClick={() => { setError(false); setEditing("pin"); }} data-testid="settings.member-password-to-pin">
            {t("settings.memberPassword.usePin")}
          </Button>
        )}
        {editing === null && !isAndroid && (
          <Button
            disabled={busy}
            onClick={() => void run(() => setMemberBiometric())}
            data-testid="settings.member-password-biometric"
          >
            {t("settings.memberPassword.useBiometric")}
          </Button>
        )}
        {method && editing === null && (
          <Button disabled={busy} onClick={() => void run(() => clearMemberUnlock())} data-testid="settings.member-password-remove">
            {t("common.remove")}
          </Button>
        )}
      </div>
      {error && (
        <span role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--danger)" }}>
          {t("settings.memberPassword.errorGeneric")}
        </span>
      )}
    </div>
  );
}
