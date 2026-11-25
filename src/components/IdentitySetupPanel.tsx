// SPDX-License-Identifier: AGPL-3.0-only
// The identity ceremony, as a PANEL rather than a dialog (myne-md/myne#911
// task 6). The body is unchanged from the dialog it came out of
// (myne-md/myne#711, #780, #792, #855, #869); what moved is who owns the frame.
//
// Two hosts, one body, and that is the point rather than a tidy-up:
//
//  1. `IdentitySetupDialog` mounts it inside `ModalShell`, for Settings →
//     Sync, where an identity is added NEXT TO existing vaults.
//  2. `FirstRun` mounts it inline on the first-run stage, where it is not a
//     dialog at all: it is the one thing the app is asking for, and wrapping it
//     in a modal over an empty welcome screen would offer an × to a user with
//     nowhere to go.
//
// A second copy of this ceremony is how the two would come to disagree about
// what the phrase means, so there is one.
//
// **The server branch is gone** (myne-md/myne#911 task 6). Creating an identity
// is network-free: the keypair derives from the phrase, the frame is sealed on
// disk, and registration is a separate act the identity home offers later
// (`person_register_from_host`). The first-run server step and the
// "change server" link that used to open it therefore left this panel: asking
// for an address during onboarding was asking the user to configure something
// the product does not need in order to give them a working vault.
import {
  useEffect,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type MutableRefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./primitives/Button";
import { CHOICE_ACTION_STYLE, ChoiceCard, ChoiceRow } from "./ChoiceList";
import { Input } from "./primitives/Input";
import { personSetup, personStatus, type PersonAccountState, type PersonSetupView } from "../lib/personAccount";
import { personLock } from "../lib/invite";
import { PhraseEntryGrid, PHRASE_CELL_COUNT } from "./PhraseEntryGrid";
import { applyPastedPhrase, phrasePasteTokens } from "@myne/client-core/phrase-cells";
import { SecretDisplayCaveats } from "./SecretDisplayCaveats";
import { SecretPhraseReveal, useLocalPhraseReveal } from "./SecretPhraseReveal";
import { PhraseTypeBack, phraseTypeBackMatches, type TypeBackPositions } from "./PhraseTypeBack";
import { drawConfirmPositions } from "../screens/vault-creation/reducer";

interface IdentitySetupPanelProps {
  /** Fired once the ceremony is complete: the phrase has been shown, saved and
   *  proven by the type-back, or an existing identity was recovered. */
  onDone: () => void;
  /** The way out before a ceremony completes. Omitted where the host already
   *  owns an exit (a modal's × and backdrop do). */
  onCancel?: () => void;
  /**
   * `data-testid` prefix for every control in the ceremony. Defaults to the
   * dialog's, so the existing suites keep addressing the same ids; the first-run
   * host passes its own so one screen's ids cannot silently satisfy a selector
   * meant for the other.
   */
  testIdPrefix?: string;
  /**
   * Reported whenever the ceremony's shape changes: whether a phrase is on
   * screen, which half of the ceremony that is, and whether the type-back has
   * been passed. A modal host needs the last one to decide whether it may be
   * dismissed at all (myne-md/myne#869), and it cannot read it out of the panel
   * any other way.
   */
  onCeremonyState?: (state: {
    phraseShown: boolean;
    step: "phrase" | "confirm";
    challengePassed: boolean;
  }) => void;
  /**
   * The same three facts, written on every render rather than from an effect.
   * A host that must answer "may this be dismissed" from a listener it did not
   * just register reads THIS, because a listener can be read in the window
   * between a paint and an effect (see the assignment's own comment).
   */
  ceremonyStateRef?: MutableRefObject<{
    phraseShown: boolean;
    step: "phrase" | "confirm";
    challengePassed: boolean;
  }>;
}

/** Which failure the single error slot is showing. */
type ErrorKind = "generic" | "alreadyHeld";

/**
 * Read the serialized `SyncDeviceError::kind` off a rejected invoke. The plugin
 * rejects with a `{ kind }` object; anything else collapses to the generic arm.
 *
 * Only two arms remain, because only two are reachable: `personSetup` no longer
 * talks to a server (task 4 made registration best-effort and task 6 removed the
 * step), so the TLS / not-configured / invite-code failures it used to name are
 * answers to a question onboarding no longer asks.
 */
function errorKindOf(error: unknown): ErrorKind {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? (error as { kind?: unknown }).kind
      : undefined;
  if (kind === "AlreadyHeldIdentity") return "alreadyHeld";
  return "generic";
}

const emptyRecoveryCells = (): string[] =>
  Array.from({ length: PHRASE_CELL_COUNT }, () => "");

const BODY_STYLE = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
} as const;

export function IdentitySetupPanel({
  onDone,
  onCancel,
  testIdPrefix = "identity-setup",
  onCeremonyState,
  ceremonyStateRef,
}: IdentitySetupPanelProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKind | null>(null);
  const [recoveryCells, setRecoveryCells] = useState<string[]>(emptyRecoveryCells);
  const [result, setResult] = useState<PersonSetupView | null>(null);
  // True when a sealed identity exists on this device even if it never enrolled.
  const [heldIdentity, setHeldIdentity] = useState(false);
  // The device's account lifecycle, read from DISK (`sync_person_status`) rather
  // than from `PersonSetupView.approved`, and the distinction is the whole point:
  // `sync_person_setup` registers nothing, so both of its arms answer
  // `approved: false` unconditionally and the note that field gated said
  // "waiting for another device" on every first device, where nothing waits
  // (myne-md/myne#911). `pending` is the only state that is actually waiting.
  const [accountState, setAccountState] = useState<PersonAccountState | null>(null);
  // The held identity's public code, shown while it is held/locked so the panel
  // shows THAT identity rather than only a recover form (myne-md/myne#792
  // follow-up). Public material; also shown in the member roster when unlocked.
  const [heldCode, setHeldCode] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  // Whether the 24-word recovery grid is open. Closed by default so a person
  // creating their FIRST identity is not met by twenty-four empty fields; a
  // held identity opens it unconditionally, since Recover is its only door.
  const [recoverOpen, setRecoverOpen] = useState(false);
  // The identity phrase gets the same display protections the vault phrase got
  // (myne-md/myne#768): hidden until revealed, re-hidden on a walk-away. Local
  // state rather than a reducer, because this panel owns no step machine.
  const reveal = useLocalPhraseReveal();
  // The identity phrase gets the type-back ceremony (myne-md/myne#855).
  // Section 7.1.3's "demonstrate the phrase, not memorize" is a property of the
  // secret, not of the ceremony, and without it a user who never saved the
  // phrase gets no signal until they lose the device, and an identity cannot be
  // recovered without it. The four positions are drawn once, in `run`, from the
  // phrase the backend just generated; recover draws none, because typing all
  // 24 words is already the demonstration.
  const [confirmPositions, setConfirmPositions] = useState<TypeBackPositions | null>(null);
  const [confirmInputs, setConfirmInputs] = useState<Record<number, string>>({});
  // Which half of the ceremony is on screen (myne-md/myne#869). Reset by `run`
  // and `reset`, so every entry into the ceremony starts on the phrase.
  const [step, setStep] = useState<"phrase" | "confirm">("phrase");
  const typeBack =
    result?.phrase && confirmPositions
      ? phraseTypeBackMatches(result.phrase.split(" "), confirmPositions, confirmInputs)
      : null;
  // The Done CTA is the commit here, so the challenge gates it: a checkbox, or
  // nothing, is not evidence (section 7.1.3).
  const doneDisabled = typeBack !== null && !typeBack.allMatch;

  // Read the held-identity state whenever the panel mounts, so a device that
  // already holds a sealed keypair (from an earlier session or another B2B
  // flow) is steered to Recover rather than offered a doomed Create. The same
  // probe carries the account lifecycle, which is what the pending note reads:
  // one device-local read, two facts.
  useEffect(() => {
    let alive = true;
    void personStatus()
      .then((status) => {
        if (alive) {
          setHeldIdentity(status.sealed_keypair_present);
          setHeldCode(status.identity_code);
          setAccountState(status.state);
        }
      })
      .catch(() => {
        /* probe failed: keep the default Create affordance and let the
           backend's typed error surface the held-identity case instead. */
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Re-read the lifecycle after a ceremony. Best-effort by design: a failed read
   * leaves no note rather than claiming a wait nobody can end.
   */
  async function refreshAccountState() {
    try {
      setAccountState((await personStatus()).state);
    } catch {
      setAccountState(null);
    }
  }

  async function run(phrase?: string) {
    setBusy(true);
    setError(null);
    try {
      const view = await personSetup(phrase);
      setResult(view);
      // After the result, because the ceremony itself changes the answer: a
      // create leaves the device `reserved`, a recovery of a pending device
      // leaves it `pending`. Not awaited before `setResult`, so a slow or
      // failing probe cannot delay the one screen that shows the phrase.
      void refreshAccountState();
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

  const testId = (suffix: string) => `${testIdPrefix}.${suffix}`;

  // Report the ceremony's shape upward. An effect rather than a render-time call
  // so a host's setState cannot run during this component's render.
  const phraseShown = result?.phrase != null;
  const challengePassed = typeBack?.allMatch === true;
  // Written DURING RENDER, not from an effect, and that is the point: the gate
  // has to be right on the FIRST paint that shows the phrase. An effect lands a
  // microtask later, which is a window the modal's Escape listener can be read
  // in, and the failure it produces is a silent skip of the type-back challenge
  // (measured: `identitySetupTypeBack` went red only when the whole directory
  // ran, because the extra scheduling moved the assertion inside that window).
  // Mutating a ref in render is safe here because the write is idempotent and
  // nothing reads it during this component's own render.
  if (ceremonyStateRef) {
    ceremonyStateRef.current = { phraseShown, step, challengePassed };
  }
  // The effect mirrors the same facts into state, for the parts of the frame
  // that are PRESENTATION (the title, and hiding the close button). A frame
  // late there is invisible; a frame late on the gate is not.
  useEffect(() => {
    onCeremonyState?.({ phraseShown, step, challengePassed });
  }, [onCeremonyState, phraseShown, step, challengePassed]);

  return (
    <>
      {result ? (
        <div style={BODY_STYLE}>
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
                  testIdPrefix={testId("phrase")}
                  gridTestId={testId("phrase")}
                  saveFilename="myne-identity-phrase.txt"
                />
                {/* The platform caveats, the same three the vault kit carries
                    (myne-md/myne#911 task 13). The identity phrase is the
                    account's only recovery credential, so the screen that shows
                    it owes exactly what the kit owes: whether the clipboard is
                    cleared, whether a browser extension can read the page, and
                    whether this client will ask for the words again. */}
                <SecretDisplayCaveats testIdPrefix={testId("phrase.caveats")} />
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
                    testIdPrefix={testId("confirm")}
                  />
                ) : null}
              </>
            )
          ) : (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
              {t("identitySetup.recovered")}
            </div>
          )}

          {accountState === "pending" ? (
            <div data-testid={testId("pending")} style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
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
                data-testid={testId("confirm-back")}
              >
                {t("common.back")}
              </Button>
            ) : null}
            <div style={{ flex: 1 }} />
            {result.phrase && step === "phrase" ? (
              <Button
                variant="primary"
                disabled={!reveal.revealed}
                onClick={() => setStep("confirm")}
                data-testid={testId("phrase-continue")}
              >
                {t("common.continue")}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={onDone}
                disabled={doneDisabled}
                data-testid={testId("close-cta")}
              >
                {t("common.done")}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div style={BODY_STYLE}>
          {heldIdentity ? (
            // A held identity cannot be opened by a freshly generated phrase, so
            // Create is replaced by the notice + Recover, with an explicit
            // destructive forget for a user who does not have the phrase. The
            // public code is shown so "an identity is held" names WHICH one.
            <>
              <div
                data-testid={testId("held")}
                style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", lineHeight: 1.6 }}
              >
                {t("identitySetup.heldIntro")}
              </div>
              {heldCode ? (
                <Input
                  readOnly
                  mono
                  aria-label={t("common.youridentitycode")}
                  value={heldCode}
                  data-testid={testId("held-code")}
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
                    data-testid={testId("create-cta")}
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
                    data-testid={testId("recover-open")}
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
              <PhraseEntryGrid
                baseId={testId("recover")}
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
                onCellPaste={() => (event: ClipboardEvent<HTMLInputElement>) => {
                  const tokens = phrasePasteTokens(event.clipboardData.getData("text"));
                  if (tokens.length < 2) return;
                  event.preventDefault();
                  setError(null);
                  setRecoveryCells((cells) => applyPastedPhrase(cells, tokens));
                }}
                gridTestId={testId("phrase-grid")}
                cellTestId={(index) =>
                  index === 0 ? testId("phrase-input") : testId(`phrase-cell-${index + 1}`)
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
                    data-testid={testId("recover-back")}
                  >
                    {t("common.back")}
                  </Button>
                )}
                <div style={{ flex: 1 }} />
                <Button
                  variant="primary"
                  disabled={busy || !recoveryCells.every((cell) => cell.length > 0)}
                  onClick={() => void run(recoveryCells.join(" "))}
                  data-testid={testId("recover-cta")}
                >
                  {t("identitySetup.recoverCta")}
                </Button>
              </div>
            </>
          )}

          {heldIdentity ? (
            confirmForget ? (
              <div
                data-testid={testId("forget-confirm")}
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
                    data-testid={testId("forget-cancel")}
                  >
                    {t("common.keepit")}
                  </Button>
                  <div style={{ flex: 1 }} />
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => void forgetAndCreate()}
                    data-testid={testId("forget-confirm-cta")}
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
                data-testid={testId("forget-cta")}
              >
                {t("identitySetup.forgetCta")}
              </Button>
            )
          ) : null}

          {/* The host's own way out, when it has one, and in the shape every
              other first-run step gives it: `ghost` with the arrow, on the LEFT of
              the footer, at its natural width (`vault-creation/*`, and
              `RestoreBackup`'s own exit, which is the same door one flow over).
              A way OUT of the flow is a step back, not a sentence under the card.
              Omitted inside a modal, whose × and backdrop already do this and
              whose refusal rules the dialog keeps. */}
          {onCancel ? (
            <Button
              variant="ghost"
              icon="arrow-left"
              disabled={busy}
              onClick={onCancel}
              style={{ alignSelf: "flex-start" }}
              data-testid={testId("cancel")}
            >
              {t("common.back")}
            </Button>
          ) : null}
        </div>
      )}

      {error ? (
        <div
          data-testid={testId("error")}
          role="alert"
          style={{ marginTop: "var(--space-3)", fontSize: "var(--text-sm)", color: "var(--danger)" }}
        >
          {t(error === "alreadyHeld" ? "identitySetup.errorAlreadyHeld" : "identitySetup.error")}
        </div>
      ) : null}
    </>
  );
}
