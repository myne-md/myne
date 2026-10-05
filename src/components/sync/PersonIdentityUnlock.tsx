// SPDX-License-Identifier: AGPL-3.0
// The person-identity session unlock, inline (myne-md/myne#831: moved out of
// MemberRosterPanel). One phrase entry, one surface: the Sync panel's Identity
// block owns it, and the member roster reads the resulting
// `personIdentityState` store instead of rendering a second grid.
//
// It calls `personUnlock` (`sync_person_unlock`), the local once-per-process
// session unlock of the backend-held sealed keypair. That is deliberately NOT
// the setup dialog's recover path, which re-registers the person account at the
// sync server; a locked session needs no round trip.
//
// Web-substituted to `null` by build-time substitution, like MemberRosterPanel
// and IdentitySetupDialog: the phrase prompt must stay out of the served bundle
// (`web/src/components/sync/PersonIdentityUnlock.tsx`,
// `scripts/check-web-no-phrase.mjs`).
import {
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ClipboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { personUnlock } from "../../lib/invite";
import { Button } from "../primitives/Button";
import { EnrollPhraseCredential, PHRASE_CELL_COUNT } from "./EnrollPhraseCredential";
import { buildPhraseCredential } from "./phrase-credential";
import {
  getPersonIdentityGeneration,
  setPersonIdentityStateForGeneration,
} from "./personIdentityState";

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  alignSelf: "stretch",
};

const ERROR_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

const emptyCells = (): string[] =>
  Array.from({ length: PHRASE_CELL_COUNT }, () => "");

export function PersonIdentityUnlock({
  open,
  onOpenChange,
}: {
  /** Expanded state, lifted so the Sync status indicator can open it too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [phraseCells, setPhraseCells] = useState<string[]>(emptyCells);
  const [error, setError] = useState(false);
  // The generation guard in personIdentityState only drops an unlock that
  // resolves after a session reset; it does not stop two in-flight submits
  // racing each other, so the button carries its own guard.
  const [busy, setBusy] = useState(false);

  const setPhraseCell = (index: number, value: string) => {
    setError(false);
    const cleaned = value.replace(/\s+/g, "");
    setPhraseCells((cells) => cells.map((cell, i) => (i === index ? cleaned : cell)));
  };

  const handlePhraseCellChange =
    (index: number) => (event: ChangeEvent<HTMLInputElement>) => {
      setPhraseCell(index, event.target.value);
    };

  const handlePhraseCellPaste =
    (index: number) => (event: ClipboardEvent<HTMLInputElement>) => {
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
    };

  const unlock = async () => {
    if (busy) return;
    setBusy(true);
    const unlockGeneration = getPersonIdentityGeneration();
    try {
      const view = await personUnlock(buildPhraseCredential(phraseCells));
      if (
        !setPersonIdentityStateForGeneration(unlockGeneration, {
          ready: true,
          ownerCode: view.identity_code,
        })
      ) {
        return;
      }
      setPhraseCells(emptyCells());
      setError(false);
      onOpenChange(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="sync.panel.identity-unlock" style={SECTION_STYLE}>
      {open ? (
        <>
          <EnrollPhraseCredential
            baseId="sync.panel.identity-unlock"
            cells={phraseCells}
            onCellChange={handlePhraseCellChange}
            onCellPaste={handlePhraseCellPaste}
            gridTestId="sync.panel.identity-unlock.phrase-grid"
            cellTestId={(index) =>
              index === 0
                ? "sync.panel.identity-unlock.phrase-input"
                : `sync.panel.identity-unlock.phrase-cell-${index + 1}`
            }
          />
          <Button
            type="button"
            variant="primary"
            style={{ alignSelf: "flex-start" }}
            data-testid="sync.panel.identity-unlock.submit"
            disabled={busy || !phraseCells.every((cell) => cell.length > 0)}
            onClick={() => void unlock()}
          >
            {t("sync.memberRoster.personUnlock")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            style={{ alignSelf: "flex-start" }}
            data-testid="sync.panel.identity-unlock.cancel"
            onClick={() => {
              onOpenChange(false);
              setPhraseCells(emptyCells());
              setError(false);
            }}
          >
            {t("common.cancel")}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="secondary"
          style={{ alignSelf: "flex-start" }}
          data-testid="sync.panel.identity-unlock.open"
          onClick={() => {
            onOpenChange(true);
            setError(false);
          }}
        >
          {t("sync.memberRoster.personUnlockOpen")}
        </Button>
      )}
      {error ? (
        <p data-testid="sync.panel.identity-unlock.error" style={ERROR_STYLE}>
          {t("sync.memberRoster.personError")}
        </p>
      ) : null}
    </div>
  );
}
