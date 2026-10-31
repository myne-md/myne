// SPDX-License-Identifier: AGPL-3.0

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "../primitives/Input";
import { PasswordInput } from "../PasswordInput";
import { ctaInteraction, ctaStyle } from "../primitives/CenteredCard";
import {
  memberUnlockStatus,
  personStatus,
  personUnlockMemberVaultWithBiometric,
  personUnlockMemberVaultWithPassword,
  personUnlockMemberVaultWithPin,
  type MemberUnlockMethod,
} from "../../lib/personAccount";
import type { VaultId } from "../../lib/stage";
import { setPersonIdentityState } from "./personIdentityState";

/** Minimum PIN length, mirroring the Rust `pin::MIN_PIN_LEN`. */
const MIN_PIN_LEN = 6;

/** The shell supplies the card, so the body only lays out its own rows. */
const MEMBER_FORM: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  marginTop: "var(--space-4)",
};

/**
 * The unlock surface for a B2B member vault. A member vault carries ONE
 * device-local credential (`vault.member-unlock`, decisions/protocol/0653): a
 * password, a PIN, or a biometric, and this card offers whichever is configured.
 *
 * **There is no recovery-phrase arm, and that is deliberate** (myne-md/myne#938
 * task 12, `0763`). `vault.member-key`, the phrase-sealed sibling that made the
 * phrase a second way in, is retired, so a member has exactly one way in. A
 * device with no credential is therefore not "waiting for the phrase": it needs a
 * fresh invite, and the card says so instead of offering a form that would fail.
 *
 * **It is a BODY, not a screen** (Aşama 2b). It used to draw its own
 * `CenteredCard` and be returned EARLY from `Unlock.tsx`, so a member vault got a
 * different screen from an owner vault: no brand mark, no heading, and — the part
 * that matters — no way to say WHICH vault was being opened, on the one screen
 * whose whole job is to ask that. The early return also meant the member branch
 * received none of the shell's slots, so a member had no back link at any vault
 * count. It renders into `AuthShell` now, like the password form, and the two
 * surfaces differ only in the credential they offer.
 */
export function MemberVaultUnlockCard({
  vaultId,
  onUnlocked,
}: {
  vaultId: VaultId;
  onUnlocked: () => void;
}) {
  const { t } = useTranslation();
  // `undefined` = probe in flight (render no credential, so a configured method
  // never flashes the wrong form); `null` = no credential on this device at all.
  const [method, setMethod] = useState<MemberUnlockMethod | null | undefined>(undefined);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMethod(undefined);
    void Promise.resolve(memberUnlockStatus(vaultId)).then(
      (m) => {
        if (!cancelled) setMethod(m ?? null);
      },
      () => {
        if (!cancelled) setMethod(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  const surface: "pending" | MemberUnlockMethod | "none" =
    method === undefined ? "pending" : method === null ? "none" : method;
  const canSubmit =
    surface === "password"
      ? password.length > 0
      : surface === "pin"
        ? pin.length >= MIN_PIN_LEN
        : surface === "biometric";

  const finish = async () => {
    try {
      const person = await personStatus();
      setPersonIdentityState({
        ready: person.identity_unlocked,
        ownerCode: person.identity_code,
      });
    } catch {
      setPersonIdentityState({ ready: false, ownerCode: null });
    }
    onUnlocked();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !canSubmit) return;
    setBusy(true);
    setError(false);
    try {
      if (surface === "password") {
        await personUnlockMemberVaultWithPassword(vaultId, password);
        setPassword("");
      } else if (surface === "pin") {
        await personUnlockMemberVaultWithPin(vaultId, pin);
        setPin("");
      } else if (surface === "biometric") {
        await personUnlockMemberVaultWithBiometric(vaultId);
      }
      await finish();
    } catch {
      setError(true);
      setBusy(false);
    }
  };

  // A `switch` rather than a ternary chain, because the chain ended on
  // `memberBiometricHint` and so answered it for `pending` AND `none`: a device
  // with no credential at all was told to approve with a fingerprint it does not
  // have, directly above the paragraph that says to ask the owner for an invite
  // (myne-md/myne#938 review). A surface with no control above it has no hint.
  const hint: string | null = (() => {
    switch (surface) {
      case "password":
        return t("unlock.memberPasswordHint");
      case "pin":
        return t("unlock.memberPinHint");
      case "biometric":
        return t("unlock.memberBiometricHint");
      case "pending":
      case "none":
        return null;
    }
  })();

  return (
    <form onSubmit={submit} data-testid="unlock.member-form" style={MEMBER_FORM}>
      {hint === null ? null : (
        <p
          data-testid="unlock.member-hint"
          style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--fg-2)" }}
        >
          {hint}
        </p>
      )}
        {surface === "pending" ? null : surface === "password" ? (
          <PasswordInput
            label={t("unlock.memberPasswordLabel")}
            value={password}
            onChange={(next) => {
              setError(false);
              setPassword(next);
            }}
            show={showPassword}
            onToggleShow={() => setShowPassword((s) => !s)}
            disabled={busy}
            autoFocus
            testId="unlock.member-password"
          />
        ) : surface === "pin" ? (
          <Input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => {
              setError(false);
              setPin(e.target.value);
            }}
            placeholder={t("unlock.memberPinPlaceholder", { count: MIN_PIN_LEN })}
            aria-label={t("unlock.memberPinLabel")}
            disabled={busy}
            data-testid="unlock.member-pin"
          />
        ) : surface === "biometric" ? null : surface === "none" ? (
          // No credential on this device. A form here would be a dead end: the
          // phrase does not open a shared vault any more, so the only remedy is a
          // fresh invite, and the copy names it.
          <p
            data-testid="unlock.member-no-credential"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-2)",
            }}
          >
            {t("unlock.memberNoCredential")}
          </p>
        ) : null}
        {surface === "none" ? null : (
          <button
            type="submit"
            data-testid="unlock.member-submit"
            disabled={busy || !canSubmit}
            style={ctaStyle(busy || !canSubmit)}
            {...ctaInteraction(busy || !canSubmit)}
          >
            {surface === "biometric" ? t("unlock.memberBiometricSubmit") : t("unlock.memberSubmit")}
          </button>
        )}
        {error ? (
          <p data-testid="unlock.member-error" style={{ color: "var(--danger)", fontFamily: "var(--font-sans)" }}>
            {t("unlock.memberPasswordError")}
          </p>
        ) : null}
      </form>
  );
}
