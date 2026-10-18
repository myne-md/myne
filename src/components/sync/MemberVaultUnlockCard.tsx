// SPDX-License-Identifier: AGPL-3.0

import {
  useEffect,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { CenteredCard, ctaInteraction, ctaStyle } from "../primitives/CenteredCard";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { PasswordInput } from "../PasswordInput";
import {
  memberUnlockStatus,
  personStatus,
  personUnlockMemberVault,
  personUnlockMemberVaultWithBiometric,
  personUnlockMemberVaultWithPassword,
  personUnlockMemberVaultWithPin,
  type MemberUnlockMethod,
} from "../../lib/personAccount";
import type { VaultId } from "../../lib/stage";
import { setPersonIdentityState } from "./personIdentityState";
import { PhraseEntryGrid, PHRASE_CELL_COUNT } from "../PhraseEntryGrid";

/** Minimum PIN length, mirroring the Rust `pin::MIN_PIN_LEN`. */
const MIN_PIN_LEN = 6;

/**
 * The unlock surface for a B2B member vault. A member holds no vault password:
 * their portable credential is their own recovery phrase (`vault.member-key`,
 * decisions/protocol/0606), and they may set a device-local fast credential
 * (`vault.member-unlock`, decisions/protocol/0653): a password, a PIN, or a
 * biometric. This card offers whichever is configured, with the recovery phrase
 * always one click away as the fallback.
 */
export function MemberVaultUnlockCard({
  vaultId,
  onUnlocked,
}: {
  vaultId: VaultId;
  onUnlocked: () => void;
}) {
  const { t } = useTranslation();
  // `undefined` = probe in flight (render neither credential, so a configured
  // method never flashes the phrase grid); `null` = no fast credential.
  const [method, setMethod] = useState<MemberUnlockMethod | null | undefined>(undefined);
  const [usePhrase, setUsePhrase] = useState(false);
  const [phraseCells, setPhraseCells] = useState<string[]>(() =>
    Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
  );
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMethod(undefined);
    setUsePhrase(false);
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

  const surface: "pending" | MemberUnlockMethod | "phrase" =
    method === undefined ? "pending" : method !== null && !usePhrase ? method : "phrase";
  const canSubmit =
    surface === "password"
      ? password.length > 0
      : surface === "pin"
        ? pin.length >= MIN_PIN_LEN
        : surface === "biometric"
          ? true
          : surface === "phrase"
            ? phraseCells.every((cell) => cell.length > 0)
            : false;

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
      } else {
        await personUnlockMemberVault(vaultId, phraseCells.join(" "));
        setPhraseCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));
      }
      await finish();
    } catch {
      setError(true);
      setBusy(false);
    }
  };

  const hint =
    surface === "password"
      ? t("unlock.memberPasswordHint")
      : surface === "pin"
        ? t("unlock.memberPinHint")
        : surface === "biometric"
          ? t("unlock.memberBiometricHint")
          : t("unlock.memberHint");

  return (
    <CenteredCard>
      <form onSubmit={submit} data-testid="unlock.member-form">
        <p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          {hint}
        </p>
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
        ) : surface === "biometric" ? null : (
          <PhraseEntryGrid
            baseId="unlock-member"
            label={t("unlock.memberPhraseLabel")}
            disabled={busy}
            cells={phraseCells}
            onCellChange={(index) => (event: ChangeEvent<HTMLInputElement>) => {
              setError(false);
              setPhraseCells((cells) =>
                cells.map((cell, cellIndex) =>
                  cellIndex === index ? event.target.value.replace(/\s+/g, "") : cell,
                ),
              );
            }}
            onCellPaste={(index) => (event: ClipboardEvent<HTMLInputElement>) => {
              const tokens = event.clipboardData
                .getData("text")
                .split(/\s+/)
                .filter((token) => token.length > 0);
              if (tokens.length < 2) return;
              event.preventDefault();
              setError(false);
              setPhraseCells((cells) => {
                const next = [...cells];
                for (let i = 0; i < tokens.length && index + i < PHRASE_CELL_COUNT; i += 1) {
                  next[index + i] = tokens[i];
                }
                return next;
              });
            }}
            gridTestId="unlock.member-phrase-grid"
            cellTestId={(index) =>
              index === 0 ? "unlock.member-phrase" : `unlock.member-phrase-cell-${index + 1}`
            }
          />
        )}
        <button
          type="submit"
          data-testid="unlock.member-submit"
          disabled={busy || !canSubmit}
          style={ctaStyle(busy || !canSubmit)}
          {...ctaInteraction(busy || !canSubmit)}
        >
          {surface === "biometric" ? t("unlock.memberBiometricSubmit") : t("unlock.memberSubmit")}
        </button>
        {method != null ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setError(false);
              setUsePhrase((v) => !v);
            }}
            data-testid="unlock.member-toggle-credential"
            style={{ marginTop: "var(--space-3)" }}
          >
            {surface === "phrase" ? t("unlock.memberUseFast") : t("unlock.memberUsePhrase")}
          </Button>
        ) : null}
        {error ? (
          <p data-testid="unlock.member-error" style={{ color: "var(--danger)", fontFamily: "var(--font-sans)" }}>
            {surface === "phrase" ? t("unlock.memberError") : t("unlock.memberPasswordError")}
          </p>
        ) : null}
      </form>
    </CenteredCard>
  );
}
