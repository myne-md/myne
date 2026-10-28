// SPDX-License-Identifier: AGPL-3.0

import {
  useEffect,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Input } from "../primitives/Input";
import { PasswordInput } from "../PasswordInput";
import { ctaInteraction, ctaStyle } from "../primitives/CenteredCard";
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
import { applyPastedPhrase, phrasePasteTokens } from "@myne/client-core/phrase-cells";

/** Minimum PIN length, mirroring the Rust `pin::MIN_PIN_LEN`. */
const MIN_PIN_LEN = 6;

/** The shell supplies the card, so the body only lays out its own rows. */
const MEMBER_FORM: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  marginTop: "var(--space-4)",
};

/** The credential swap, at the same rank as the owner screen0027s `unlock.alt-row`. */
const ALT_LINK_STYLE: CSSProperties = {
  alignSelf: "center",
  background: "none",
  border: 0,
  padding: 0,
  cursor: "pointer",
  color: "var(--fg-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

/**
 * The unlock surface for a B2B member vault. A member holds no vault password:
 * their portable credential is their own recovery phrase (`vault.member-key`,
 * decisions/protocol/0606), and they may set a device-local fast credential
 * (`vault.member-unlock`, decisions/protocol/0653): a password, a PIN, or a
 * biometric. This card offers whichever is configured, with the recovery phrase
 * always one click away as the fallback.
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
    <form onSubmit={submit} data-testid="unlock.member-form" style={MEMBER_FORM}>
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
            onCellPaste={() => (event: ClipboardEvent<HTMLInputElement>) => {
              const tokens = phrasePasteTokens(event.clipboardData.getData("text"));
              if (tokens.length < 2) return;
              event.preventDefault();
              setError(false);
              setPhraseCells((cells) => applyPastedPhrase(cells, tokens));
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
          // A text link rather than a ghost `Button` (Aşama 2b): it is a
          // credential SWAP on one screen, the same rank as the owner's
          // "use your password instead" link, and a bordered button made it look
          // like a second way to submit. `unlock.alt-row`'s idiom.
          <button
            type="button"
            onClick={() => {
              setError(false);
              setUsePhrase((v) => !v);
            }}
            data-testid="unlock.member-toggle-credential"
            style={ALT_LINK_STYLE}
            className="myne-text-link"
          >
            {surface === "phrase" ? t("unlock.memberUseFast") : t("unlock.memberUsePhrase")}
          </button>
        ) : null}
        {error ? (
          <p data-testid="unlock.member-error" style={{ color: "var(--danger)", fontFamily: "var(--font-sans)" }}>
            {surface === "phrase" ? t("unlock.memberError") : t("unlock.memberPasswordError")}
          </p>
        ) : null}
      </form>
  );
}
