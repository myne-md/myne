// SPDX-License-Identifier: AGPL-3.0
// Identity-only setup dialog (myne-md/myne#711, b2b-member-sync).
//
// A vault-less person can create an identity here: a 24-word phrase is
// generated and shown ONCE, the keypair is derived and sealed backend-side, and
// a person-level server account is registered. Recovering an existing identity
// takes its phrase instead. No vault is created either way; the `approved:
// false` case is a second password-path device awaiting approval.
//
// Desktop + mobile only: on web `plugin:sync|sync_person_setup` is
// `Class::Unsupported`, and Welcome is not reached at zero vaults there
// (`vaultCreation` absent routes to `account-entry`).
import { useState, type ChangeEvent, type ClipboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "./primitives/ModalShell";
import { Button } from "./primitives/Button";
import { personSetup, type PersonSetupView } from "../lib/personAccount";
import { EnrollPhraseCredential, PHRASE_CELL_COUNT } from "./sync/EnrollPhraseCredential";
import { SecretPhraseReveal, useLocalPhraseReveal } from "./SecretPhraseReveal";
import { FirstRunServerStep, useHasSyncEndpoint } from "./sync/FirstRunServerStep";

interface IdentitySetupDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful setup/recover so the host can re-probe and land
   *  the user on the identity home. */
  onCreated?: () => void;
}

export function IdentitySetupDialog({ open, onClose, onCreated }: IdentitySetupDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [recoveryCells, setRecoveryCells] = useState<string[]>(() =>
    Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
  );
  const [result, setResult] = useState<PersonSetupView | null>(null);
  // The identity phrase gets the same display protections the vault phrase gets
  // (myne-md/myne#768): hidden until revealed, re-hidden on a walk-away. Local
  // state rather than a reducer, because this dialog owns no step machine.
  const reveal = useLocalPhraseReveal();
  // Identity creation registers a person account at a sync endpoint, so it
  // cannot succeed without one. When the device has none, the dialog fronts the
  // first-run server step rather than letting the user press Create and read a
  // generic error naming a fix they cannot perform from here (myne-md/myne#768).
  const hasEndpoint = useHasSyncEndpoint();
  const [serverAcknowledged, setServerAcknowledged] = useState(false);

  async function run(phrase?: string) {
    setBusy(true);
    setError(false);
    try {
      setResult(await personSetup(phrase));
      setRecoveryCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));
    } catch {
      // Never surface the raw backend error: it can carry a stage tag but no
      // secret, and the UI cannot act differently on the variant anyway.
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  function close() {
    // The re-probe is deferred to the Done CTA (not fired from `run`), because
    // the generated recovery phrase is shown ONCE and must stay on screen until
    // the user dismisses it: firing `onCreated` from `run` lets the host re-route
    // and unmount this dialog before `result.phrase` ever renders.
    const created = result !== null;
    setResult(null);
    setError(false);
    setRecoveryCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));
    onClose();
    if (created) onCreated?.();
  }

  return (
    <ModalShell
      open={open}
      title={t("identitySetup.title")}
      onClose={close}
      labelId="identity-setup-title"
      testId="identity-setup.root"
    >
      {result ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {result.phrase ? (
            <>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", lineHeight: 1.6 }}>
                {t("identitySetup.phraseWarning")}
              </div>
              {/* The phrase arrives as one space-joined string from the backend;
                  split it for the shared reveal, which renders the numbered grid.
                  Same protections as the vault phrase, and deliberately no
                  type-back (`decisions/ui/0615`). */}
              <SecretPhraseReveal
                phrase={result.phrase.split(" ")}
                revealed={reveal.revealed}
                onReveal={reveal.onReveal}
                onHide={reveal.onHide}
                testIdPrefix="identity-setup.phrase"
                gridTestId="identity-setup.phrase"
                saveFilename="myne-identity-phrase.txt"
              />
            </>
          ) : (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
              {t("identitySetup.recovered")}
            </div>
          )}

          <div
            data-testid="identity-setup.fingerprint"
            style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--fg-3)", wordBreak: "break-all" }}
          >
            {result.fingerprint_hex}
          </div>

          {!result.approved ? (
            <div data-testid="identity-setup.pending" style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
              {t("identitySetup.pending")}
            </div>
          ) : null}

          <Button variant="primary" onClick={close} data-testid="identity-setup.close-cta">
            {t("identitySetup.doneCta")}
          </Button>
        </div>
      ) : !hasEndpoint && !serverAcknowledged ? (
        <FirstRunServerStep
          onConnected={() => setServerAcknowledged(true)}
          onBack={close}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", lineHeight: 1.6 }}>
            {t("identitySetup.intro")}
          </div>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void run()}
            data-testid="identity-setup.create-cta"
          >
            {t("identitySetup.createCta")}
          </Button>

          <div style={{ height: 1, background: "var(--line-1)", margin: "var(--space-1) 0" }} />

          <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
            {t("identitySetup.recoverIntro")}
          </div>
          <EnrollPhraseCredential
            baseId="identity-setup"
            label={t("identitySetup.recoverIntro")}
            disabled={busy}
            cells={recoveryCells}
            onCellChange={(index) => (event: ChangeEvent<HTMLInputElement>) => {
              setError(false);
              setRecoveryCells((cells) =>
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
              setRecoveryCells((cells) => {
                const next = [...cells];
                for (let i = 0; i < tokens.length && index + i < PHRASE_CELL_COUNT; i += 1) {
                  next[index + i] = tokens[i];
                }
                return next;
              });
            }}
            gridTestId="identity-setup.phrase-grid"
            cellTestId={(index) =>
              index === 0 ? "identity-setup.phrase-input" : `identity-setup.phrase-cell-${index + 1}`
            }
          />
          <Button
            variant="secondary"
            disabled={busy || !recoveryCells.every((cell) => cell.length > 0)}
            onClick={() => void run(recoveryCells.join(" "))}
            data-testid="identity-setup.recover-cta"
          >
            {t("identitySetup.recoverCta")}
          </Button>
        </div>
      )}

      {error ? (
        <div
          data-testid="identity-setup.error"
          role="alert"
          style={{ marginTop: "var(--space-3)", fontSize: "var(--text-sm)", color: "var(--danger)" }}
        >
          {t("identitySetup.error")}
        </div>
      ) : null}
    </ModalShell>
  );
}
