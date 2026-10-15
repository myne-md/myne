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
//
// The phrase ceremony is TWO steps, mirroring the vault flow's kit/typeback
// split (myne-md/myne#869): the phrase gets a step of its own and the type-back
// challenge the next one. Three things went with the old single screen. The
// fingerprint hex that sat above Done is gone: an unlabeled 64-character blob
// between the user and the button they were looking for. Done moved to the
// confirm step only, so it can no longer be pressed while the grid and the
// challenge are both on screen. And the dialog now REFUSES dismissal until the
// four words match (`ModalShell.canDismiss`): Esc, a backdrop click and the ×
// were all exits from the one screen whose phrase is shown once, and the
// challenge could not gate a door it did not own. The account is already
// registered by the time the phrase renders, so what the block protects is the
// phrase on the screen, not the identity on the server.
import { useEffect, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "./primitives/ModalShell";
import { Button } from "./primitives/Button";
import { CHOICE_ACTION_STYLE, ChoiceCard, ChoiceRow } from "./ChoiceList";
import { Input } from "./primitives/Input";
import { personSetup, personStatus, type PersonSetupView } from "../lib/personAccount";
import { personLock } from "../lib/invite";
import { EnrollPhraseCredential, PHRASE_CELL_COUNT } from "./sync/EnrollPhraseCredential";
import { SecretPhraseReveal, useLocalPhraseReveal } from "./SecretPhraseReveal";
import { PhraseTypeBack, phraseTypeBackMatches, type TypeBackPositions } from "./PhraseTypeBack";
import { drawConfirmPositions } from "../screens/vault-creation/reducer";
import { FirstRunServerStep, useHasSyncEndpoint } from "./sync/FirstRunServerStep";

interface IdentitySetupDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful setup/recover so the host can re-probe and land
   *  the user on the identity home. */
  onCreated?: () => void;
}

/** Which failure the single error slot is showing. */
type ErrorKind =
  | "generic"
  | "alreadyHeld"
  | "notConfigured"
  | "tlsFailure"
  | "inviteCodeRequired"
  | "inviteCodeInvalid";

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
  // A gated server refuses identity creation without (or with a wrong) invite
  // code. Named distinctly so the user learns the remedy is the operator's
  // code, which a generic "try again" would loop them away from
  // (myne-md/myne#800).
  if (kind === "InviteCodeRequired") return "inviteCodeRequired";
  if (kind === "InviteCodeInvalid") return "inviteCodeInvalid";
  return "generic";
}

const emptyRecoveryCells = (): string[] =>
  Array.from({ length: PHRASE_CELL_COUNT }, () => "");

const BODY_STYLE = {
  padding: "var(--space-5)",
  overflowY: "auto",
  minHeight: 0,
} as const;

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
  // Whether the 24-word recovery grid is open. Closed by default so a person
  // creating their FIRST identity is not met by twenty-four empty fields; a
  // held identity opens it unconditionally, since Recover is its only door.
  const [recoverOpen, setRecoverOpen] = useState(false);
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

  // The identity phrase gets the vault ceremony's type-back (myne-md/myne#855).
  // Section 7.1.3's "demonstrate the phrase, not memorize" is a property of the
  // secret, not of the ceremony, and without it a user who never saved the phrase
  // got no signal until they lost the device, and an identity cannot be recovered
  // without it. The four positions are drawn once, in `run`, from the phrase the
  // backend just generated; recover draws none, because typing all 24 words is
  // already the demonstration.
  const [confirmPositions, setConfirmPositions] = useState<TypeBackPositions | null>(null);
  const [confirmInputs, setConfirmInputs] = useState<Record<number, string>>({});
  // Which half of the ceremony is on screen (myne-md/myne#869). Reset by `run`
  // and `close`, so every entry into the ceremony starts on the phrase.
  const [step, setStep] = useState<"phrase" | "confirm">("phrase");
  const typeBack =
    result?.phrase && confirmPositions
      ? phraseTypeBackMatches(result.phrase.split(" "), confirmPositions, confirmInputs)
      : null;
  // The Done CTA is the commit here, so the challenge gates it: a checkbox, or
  // nothing, is not evidence (section 7.1.3).
  const doneDisabled = typeBack !== null && !typeBack.allMatch;
  // …and it gates DISMISSAL for the same reason (myne-md/myne#869). The phrase
  // is shown once; an identity whose phrase was never written down cannot be
  // recovered, so Esc, the backdrop and the × all have to stay shut until the
  // four words prove it was saved. A recovered identity draws no positions, so
  // `typeBack` is null there and the dialog dismisses as it always did: typing
  // all 24 words was already the demonstration.
  const ceremonyPending = result?.phrase != null && typeBack?.allMatch !== true;

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
      const view = await personSetup(phrase);
      setResult(view);
      setConfirmPositions(view.phrase ? drawConfirmPositions() : null);
      setConfirmInputs({});
      setRecoveryCells(emptyRecoveryCells());
      setConfirmForget(false);
      setStep("phrase");
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
    setConfirmPositions(null);
    setConfirmInputs({});
    setStep("phrase");
    setError(null);
    setRecoveryCells(emptyRecoveryCells());
    setHeldCode(null);
    setConfirmForget(false);
    setRecoverOpen(false);
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
          : error === "inviteCodeRequired"
            ? "sync.enroll.error.inviteCodeRequired"
            : error === "inviteCodeInvalid"
              ? "sync.enroll.error.inviteCodeInvalid"
              : "identitySetup.error";

  return (
    <ModalShell
      open={open}
      // Three titles, one per state the body can be in: the phrase step and the
      // type-back step say what THIS screen is for, and the initial fork keeps
      // the dialog's own name.
      title={
        result?.phrase
          ? step === "confirm"
            ? t("identitySetup.confirmTitle")
            : t("identitySetup.phraseTitle")
          : t("identitySetup.title")
      }
      onClose={close}
      labelId="identity-setup-title"
      testId="identity-setup.root"
      canDismiss={() => !ceremonyPending}
    >
      {/* The modal body carries no padding of its own (Settings fills it edge
          to edge), so a dialog that wants an inset supplies it. This one did
          not, and its copy ran into the frame. */}
      <div style={BODY_STYLE}>
      {result ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {result.phrase ? (
            step === "phrase" ? (
              // Step 1: the phrase. The string arrives space-joined from the
              // backend; it is split for the shared reveal, which renders the
              // numbered grid with the vault phrase's protections.
              <>
                <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", lineHeight: 1.6 }}>
                  {t("identitySetup.phraseWarning")}
                </div>
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
              // Step 2: the type-back (myne-md/myne#855; two-step split
              // myne-md/myne#869). `decisions/ui/0665` records the challenge;
              // the split moves it onto the screen that owns it.
              <>
                <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", lineHeight: 1.6 }}>
                  {t("identitySetup.typeBackLead")}
                </div>
                {confirmPositions ? (
                  <PhraseTypeBack
                    phrase={result.phrase.split(" ")}
                    positions={confirmPositions}
                    values={confirmInputs}
                    onChange={(pos, value) =>
                      setConfirmInputs((prev) => ({ ...prev, [pos]: value }))
                    }
                    labelFor={(pos) => t("identitySetup.typeBackWordAtPosition", { pos })}
                    mismatchFor={(pos) => t("identitySetup.typeBackMismatch", { pos })}
                    testIdPrefix="identity-setup.confirm"
                  />
                ) : null}
              </>
            )
          ) : (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
              {t("identitySetup.recovered")}
            </div>
          )}

          {!result.approved ? (
            <div data-testid="identity-setup.pending" style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
              {t("identitySetup.pending")}
            </div>
          ) : null}

          {/* One actions row for all three bodies, because the CTA and the way
              out are a function of the step: the phrase step's only way forward
              is Continue (the phrase has to be seen first), the confirm step
              carries Back plus the gated Done, and a recovered identity has
              nothing to confirm and keeps Done alone. */}
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            {result.phrase && step === "confirm" ? (
              <Button
                variant="ghost"
                icon="arrow-left"
                onClick={() => setStep("phrase")}
                data-testid="identity-setup.confirm-back"
              >
                {t("identitySetup.back")}
              </Button>
            ) : null}
            <div style={{ flex: 1 }} />
            {result.phrase && step === "phrase" ? (
              <Button
                variant="primary"
                disabled={!reveal.revealed}
                onClick={() => setStep("confirm")}
                data-testid="identity-setup.phrase-continue"
              >
                {t("identitySetup.phraseContinue")}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={close}
                disabled={doneDisabled}
                data-testid="identity-setup.close-cta"
              >
                {t("identitySetup.doneCta")}
              </Button>
            )}
          </div>
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
          ) : !recoverOpen ? (
            // The fork, as two rows that say where each leads. Recovering is
            // the rarer path, so its twenty-four fields stay behind its button.
            <ChoiceCard>
              <ChoiceRow
                title={t("identitySetup.newTitle")}
                body={t("identitySetup.intro")}
                action={
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => void run()}
                    data-testid="identity-setup.create-cta"
                    style={CHOICE_ACTION_STYLE}
                  >
                    {t("identitySetup.createAction")}
                  </Button>
                }
              />
              <ChoiceRow
                title={t("identitySetup.recoverTitle")}
                body={t("identitySetup.recoverHint")}
                action={
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setRecoverOpen(true)}
                    data-testid="identity-setup.recover-open"
                    style={CHOICE_ACTION_STYLE}
                  >
                    {t("identitySetup.recoverAction")}
                  </Button>
                }
                last
              />
            </ChoiceCard>
          ) : null}

          {(heldIdentity || recoverOpen) && (
          <>
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
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            {!heldIdentity && (
              <Button
                variant="ghost"
                icon="arrow-left"
                disabled={busy}
                onClick={() => {
                  setRecoverOpen(false);
                  setRecoveryCells(emptyRecoveryCells());
                  setError(null);
                }}
                data-testid="identity-setup.recover-back"
              >
                {t("identitySetup.back")}
              </Button>
            )}
            <div style={{ flex: 1 }} />
            <Button
              variant="primary"
              disabled={busy || !recoveryCells.every((cell) => cell.length > 0)}
              onClick={() => void run(recoveryCells.join(" "))}
              data-testid="identity-setup.recover-cta"
            >
              {t("identitySetup.recoverCta")}
            </Button>
          </div>
          </>
          )}

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
      </div>
    </ModalShell>
  );
}
