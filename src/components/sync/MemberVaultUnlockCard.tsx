// SPDX-License-Identifier: AGPL-3.0

import {
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { CenteredCard, ctaHover, ctaStyle } from "../primitives/CenteredCard";
import { personStatus, personUnlockMemberVault } from "../../lib/personAccount";
import type { VaultId } from "../../lib/stage";
import { setPersonIdentityState } from "./personIdentityState";
import { EnrollPhraseCredential, PHRASE_CELL_COUNT } from "./EnrollPhraseCredential";

export function MemberVaultUnlockCard({
  vaultId,
  onUnlocked,
}: {
  vaultId: VaultId;
  onUnlocked: () => void;
}) {
  const { t } = useTranslation();
  const [phraseCells, setPhraseCells] = useState<string[]>(() =>
    Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const canSubmit = phraseCells.every((cell) => cell.length > 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !canSubmit) return;
    setBusy(true);
    setError(false);
    try {
      await personUnlockMemberVault(vaultId, phraseCells.join(" "));
      setPhraseCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));
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
    } catch {
      setError(true);
      setBusy(false);
    }
  };

  return (
    <CenteredCard>
      <form onSubmit={submit} data-testid="unlock.member-form">
        <p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          {t("unlock.memberHint")}
        </p>
        <EnrollPhraseCredential
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
        <button
          type="submit"
          data-testid="unlock.member-submit"
          disabled={busy || !canSubmit}
          style={ctaStyle(busy || !canSubmit)}
          {...ctaHover(busy || !canSubmit)}
        >
          {t("unlock.memberSubmit")}
        </button>
        {error ? (
          <p data-testid="unlock.member-error" style={{ color: "var(--danger)", fontFamily: "var(--font-sans)" }}>
            {t("unlock.memberError")}
          </p>
        ) : null}
      </form>
    </CenteredCard>
  );
}
