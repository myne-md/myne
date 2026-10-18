// SPDX-License-Identifier: AGPL-3.0
// The person-identity session unlock (myne-md/myne#831: moved out of
// MemberRosterPanel). One phrase entry, one surface: the Sync panel's Identity
// row owns it, and the member roster reads the resulting `personIdentityState`
// store instead of rendering a second grid.
//
// A trigger button plus a DIALOG, not an inline grid (myne-md/myne#885 visual
// pass): the 24 cells expanded inside the Sync panel pushed every row below them
// off screen, and the button sat on a line of its own under the row it belonged
// to. The trigger now renders where the caller puts it (the Identity row's
// control slot, beside "Add an identity"), and the phrase entry is a modal.
//
// It calls `personUnlock` (`sync_person_unlock`), the local once-per-process
// session unlock of the backend-held sealed keypair. That is deliberately NOT
// the setup dialog's recover path, which re-registers the person account at the
// sync server; a locked session needs no round trip.
//
// SHIPS on web since `decisions.md` 2026-10-18 (entry 0704), which retired the
// build-time substitution this module used to have and deleted the
// `scripts/check-web-no-phrase.mjs` grep that asserted its absence. It is still
// unreachable there: `phraseEnrolment` and the person plane are absent
// capabilities, so no arm renders it. Present and gated, which is a weaker
// claim than absent and is stated rather than implied.
import {
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ClipboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { personUnlock } from "../../lib/invite";
import { Button } from "../primitives/Button";
import { ModalShell } from "../primitives/ModalShell";
import { PhraseEntryGrid, PHRASE_CELL_COUNT } from "../PhraseEntryGrid";
import { buildPhraseCredential } from "./phrase-credential";
import {
  getPersonIdentityGeneration,
  setPersonIdentityStateForGeneration,
} from "./personIdentityState";

// `ModalShell`'s body carries no padding of its own (a settings surface fills
// it edge to edge), so a dialog pads its own content. Without it the phrase
// grid and the buttons ran flush to the modal's border while the title above
// sat inset by the header's `--space-5` (myne-md/myne#867, on the user's read:
// "this modal has no padding"). The same inset as the header, so the content
// lines up under the title.
const BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  padding: "var(--space-4) var(--space-5) var(--space-5)",
  overflowY: "auto",
  minHeight: 0,
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
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

  const close = () => {
    onOpenChange(false);
    setPhraseCells(emptyCells());
    setError(false);
  };

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        data-testid="sync.panel.identity-unlock.open"
        onClick={() => {
          onOpenChange(true);
          setError(false);
        }}
      >
        {t("sync.memberRoster.personUnlockOpen")}
      </Button>
      <ModalShell
        open={open}
        title={t("sync.memberRoster.personUnlock")}
        onClose={close}
        labelId="sync-identity-unlock-title"
        width={640}
        testId="sync.panel.identity-unlock"
      >
        <div style={BODY_STYLE}>
          <PhraseEntryGrid
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
          {error ? (
            <p role="alert" data-testid="sync.panel.identity-unlock.error" style={ERROR_STYLE}>
              {t("sync.memberRoster.personError")}
            </p>
          ) : null}
          <div style={ACTIONS_STYLE}>
            <Button
              type="button"
              variant="ghost"
              data-testid="sync.panel.identity-unlock.cancel"
              onClick={close}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              data-testid="sync.panel.identity-unlock.submit"
              disabled={busy || !phraseCells.every((cell) => cell.length > 0)}
              onClick={() => void unlock()}
            >
              {t("sync.memberRoster.personUnlock")}
            </Button>
          </div>
        </div>
      </ModalShell>
    </>
  );
}
