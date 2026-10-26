// The identity-phrase credential for an `NTV7` vault, as a sub-view of the
// unlock screen (myne-md/myne#911 task 10).
//
// **Why this is a sub-view rather than a third arm of the password form.** The
// unlock screen's reducer is password-shaped (`idle` / `decrypting` carry a
// `password` string), and the phrase is a 24-cell entry with its own paste
// handling and its own non-distinguishing failure. Threading a second credential
// through that reducer would put two credential shapes in one state machine and
// one wrong state away from a fail-open screen. The delete-vault sub-view is the
// precedent: a distinct credential act gets its own component and its own early
// return, and the shell it replaces is the same shell.
//
// **The phrase is not a fallback for a forgotten password in the ordinary
// sense.** It is the credential the explicit upgrade puts in the vault phrase's
// place, so on an upgraded vault it is the only recovery route: the vault
// recovery flow asks for the account number and the vault phrase, and this
// generation has retired the second. That is why the unlock screen swaps the
// recovery link for this one when `vault_is_person_wrapped` answers true.

import { useState, type ChangeEvent, type ClipboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./primitives/Button";
import { PhraseEntryGrid, PHRASE_CELL_COUNT } from "./PhraseEntryGrid";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
} from "./primitives/CenteredCard";
import { unlockWithPersonPhrase } from "../lib/vault-format-upgrade";
import { UNLOCK_NON_DISTINGUISHING_BANNER } from "../lib/load-bearing-copy";

export interface PersonPhraseUnlockProps {
  /** The vault being opened. `undefined` falls through to the backend's
   *  sole-vault path, exactly as the password form does. */
  vaultId?: string;
  onUnlocked: () => void;
  onCancel: () => void;
}

export function PersonPhraseUnlock({
  vaultId,
  onUnlocked,
  onCancel,
}: PersonPhraseUnlockProps): React.ReactElement {
  const { t } = useTranslation();
  const [cells, setCells] = useState<string[]>(() =>
    Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
  );
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = cells.every((cell) => cell.length > 0) && !inFlight;

  const submit = () => {
    if (!canSubmit) return;
    setInFlight(true);
    setError(null);
    void (async () => {
      try {
        await unlockWithPersonPhrase(vaultId, cells.join(" "));
        setCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));
        onUnlocked();
      } catch (raw) {
        const kind = (raw as { kind?: unknown } | null)?.kind;
        // `InvalidCredentialOrVault` is the same literal the password form shows,
        // from the shared constant rather than a second spelling: §7.3 makes the
        // two failures indistinguishable on purpose, and a phrase-specific
        // sentence here would undo that at the surface a reader actually sees.
        if (kind === "InvalidCredentialOrVault") {
          setError(UNLOCK_NON_DISTINGUISHING_BANNER);
        } else if (kind === "VaultRecoveryInProgress") {
          setError(t("unlock.identityPhrase.recoveryInProgress"));
        } else {
          setError(t("unlock.identityPhrase.generic"));
        }
        setInFlight(false);
      }
    })();
  };

  return (
    <CenteredCard>
      <h1 style={CARD_TITLE_STYLE}>{t("unlock.identityPhrase.title")}</h1>
      <p style={CARD_BODY_STYLE}>{t("unlock.identityPhrase.body")}</p>

      <PhraseEntryGrid
        baseId="unlock-person-phrase"
        label={t("unlock.identityPhrase.label")}
        hint={t("unlock.identityPhrase.hint")}
        disabled={inFlight}
        cells={cells}
        onCellChange={(index) => (event: ChangeEvent<HTMLInputElement>) => {
          setCells((current) =>
            current.map((cell, cellIndex) =>
              cellIndex === index
                ? event.target.value.replace(/\s+/g, "")
                : cell,
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
          setCells((current) => {
            const next = [...current];
            for (let i = 0; i < tokens.length && index + i < PHRASE_CELL_COUNT; i += 1) {
              next[index + i] = tokens[i];
            }
            return next;
          });
        }}
        gridTestId="unlock.identity-phrase-grid"
        cellTestId={(index) =>
          index === 0
            ? "unlock.identity-phrase-input"
            : `unlock.identity-phrase-cell-${index + 1}`
        }
      />

      {error !== null && (
        <div
          role="alert"
          data-testid="unlock.identity-phrase-error"
          style={{ color: "var(--danger)", fontSize: "var(--text-sm)" }}
        >
          {error}
        </div>
      )}

      <Button
        variant="primary"
        onClick={submit}
        disabled={!canSubmit}
        data-testid="unlock.identity-phrase-submit"
      >
        {inFlight
          ? t("unlock.identityPhrase.decrypting")
          : t("unlock.identityPhrase.submit")}
      </Button>

      <Button
        variant="ghost"
        onClick={onCancel}
        data-testid="unlock.identity-phrase-cancel"
      >
        {t("unlock.identityPhrase.cancel")}
      </Button>
    </CenteredCard>
  );
}
