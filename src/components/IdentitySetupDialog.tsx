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
//
// A device can already hold a recoverable sealed identity with no token
// (`sealed_keypair_present`, myne-md/myne#780). In that state Create generates a
// fresh phrase that cannot open the sealed frame it did not write, so the
// backend answers `AlreadyHeldIdentity` and the old dialog showed a generic
// error blaming the sync server. This dialog reads the status up front and, when
// an identity is held, offers Recover plus an explicit destructive forget
// instead of a Create that is guaranteed to fail.
import { useEffect, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "./primitives/ModalShell";
import { Button } from "./primitives/Button";
import { Input } from "./primitives/Input";
import { personSetup, personStatus, type PersonSetupView } from "../lib/personAccount";
import { personLock } from "../lib/invite";
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

/** Which failure the single error slot is showing. */
type ErrorKind = "generic" | "alreadyHeld" | "notConfigured" | "tlsFailure";

/**
 * Read the serialized `SyncDeviceError::kind` off a rejected invoke. The plugin
 * rejects with a `{ kind }` object; anything else collapses to the generic arm.
 */
function errorKindOf(error: unknown): ErrorKind {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? (error as { kind?: unknown }).kind
      : undefined;
  if (kind === "AlreadyHeldIdentity") return "alreadyHeld";
  if (kind === "NotConfigured") return "notConfigured";
  if (kind === "TlsFailure") return "tlsFailure";
  return "generic";
}

const emptyRecoveryCells = (): string[] =>
  Array.from({ length: PHRASE_CELL_COUNT }, () => "");

export function IdentitySetupDialog({ open, onClose, onCreated }: IdentitySetupDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKind | null>(null);
  const [recoveryCells, setRecoveryCells] = useState<string[]>(emptyRecoveryCells);
  const [result, setResult] = useState<PersonSetupView | null>(null);
  // True when a sealed identity exists on this device even if it never enrolled.
  const [heldIdentity, setHeldIdentity] = useState(false);
  // The held identity's public code, shown while it is held/locked so the dialog
  // shows THAT identity rather than only a recover form (myne-md/myne#792
  // follow-up). Public material; also shown in the member roster when unlocked.
  const [heldCode, setHeldCode] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
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
  const [serverSelectionOpen, setServerSelectionOpen] = useState(false);

  // Read the held-identity state whenever the dialog is opened, so a device
  // that already holds a sealed keypair (from an earlier session or another
  // B2B flow) is steered to Recover rather than offered a doomed Create.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void personStatus()
      .then((status) => {
        if (alive) {
          setHeldIdentity(status.sealed_keypair_present);
          setHeldCode(status.identity_code);
        }
      })
      .catch(() => {
        /* probe failed: keep the default Create affordance and let the
           backend's typed error surface the held-identity case instead. */
      });
    return () => {
      alive = false;
    };
  }, [open]);

  async function run(phrase?: string) {
    setBusy(true);
    setError(null);
    try {
      setResult(await personSetup(phrase));
      setRecoveryCells(emptyRecoveryCells());
      setConfirmForget(false);
    } catch (e) {
      const kind = errorKindOf(e);
      // A stale status probe: the backend still holds an identity. Reveal the
      // forget path rather than only a generic error.
      if (kind === "alreadyHeld") setHeldIdentity(true);
      setError(kind);
    } finally {
      setBusy(false);
    }
  }

  /** Forget the held identity on this device, then create a fresh one. */
  async function forgetAndCreate() {
    setConfirmForget(false);
    setBusy(true);
    setError(null);
    try {
      await personLock(true);
      setHeldIdentity(false);
    } catch {
      setError("generic");
      setBusy(false);
      return;
    }
    await run();
  }

  function close() {
    // The re-probe is deferred to the Done CTA (not fired from `run`), because
    // the generated recovery phrase is shown ONCE and must stay on screen until
    // the user dismisses it: firing `onCreated` from `run` lets the host re-route
    // and unmount this dialog before `result.phrase` ever renders.
    const created = result !== null;
    setResult(null);
    setError(null);
    setRecoveryCells(emptyRecoveryCells());
    setHeldCode(null);
    setConfirmForget(false);
    onClose();
    if (created) onCreated?.();
  }

  const errorKey =
    error === "tlsFailure"
      ? "identitySetup.errorTlsFailure"
      : error === "notConfigured"
        ? "identitySetup.errorNotConfigured"
        : error === "alreadyHeld"
          ? "identitySetup.errorAlreadyHeld"
          : "identitySetup.error";

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
      ) : (!hasEndpoint && !serverAcknowledged) || serverSelectionOpen ? (
        <FirstRunServerStep
          requireConnection={serverSelectionOpen}
          onConnected={() => {
            setServerAcknowledged(true);
            setServerSelectionOpen(false);
            setError(null);
          }}
          onBack={serverSelectionOpen ? () => setServerSelectionOpen(false) : close}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setServerSelectionOpen(true)}
            data-testid="identity-setup.change-server"
          >
            {t("identitySetup.changeServer")}
          </Button>
          {heldIdentity ? (
            // A held identity cannot be opened by a freshly generated phrase, so
            // Create is replaced by the notice + Recover, with an explicit
            // destructive forget for a user who does not have the phrase. The
            // public code is shown so "an identity is held" names WHICH one.
            <>
              <div
                data-testid="identity-setup.held"
                style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", lineHeight: 1.6 }}
              >
                {t("identitySetup.heldIntro")}
              </div>
              {heldCode ? (
                <Input
                  readOnly
                  mono
                  aria-label={t("sync.panel.identity.codeLabel")}
                  value={heldCode}
                  data-testid="identity-setup.held-code"
                  style={{ userSelect: "all" }}
                  onFocus={(e) => e.target.select()}
                />
              ) : null}
            </>
          ) : (
            <>
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
            </>
          )}

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
              setError(null);
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
              setError(null);
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

          {heldIdentity ? (
            confirmForget ? (
              <div
                data-testid="identity-setup.forget-confirm"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                  border: "1px solid var(--danger)",
                  borderRadius: "var(--radius-2)",
                  padding: "var(--space-3)",
                }}
              >
                <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", lineHeight: 1.6 }}>
                  {t("identitySetup.forgetWarning")}
                </div>
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirmForget(false)}
                    data-testid="identity-setup.forget-cancel"
                  >
                    {t("identitySetup.forgetCancel")}
                  </Button>
                  <div style={{ flex: 1 }} />
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => void forgetAndCreate()}
                    data-testid="identity-setup.forget-confirm-cta"
                  >
                    {t("identitySetup.forgetConfirm")}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmForget(true)}
                data-testid="identity-setup.forget-cta"
              >
                {t("identitySetup.forgetCta")}
              </Button>
            )
          ) : null}
        </div>
      )}

      {error ? (
        <div
          data-testid="identity-setup.error"
          role="alert"
          style={{ marginTop: "var(--space-3)", fontSize: "var(--text-sm)", color: "var(--danger)" }}
        >
          {t(errorKey)}
        </div>
      ) : null}
    </ModalShell>
  );
}
