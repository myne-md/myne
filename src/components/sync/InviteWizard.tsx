// SPDX-License-Identifier: AGPL-3.0
// The two identity invite wizards, run as full-stage takeovers by
// `IdentityHome` (myne-md/myne#871).
//
// # Why they are steps now
//
// Accepting an invitation collects three independent things: the owner's
// identity code, the person's OWN recovery phrase, and a password for this
// device. The single long form these
// flows used to be asked for all three at once, so the submit sat below the
// fold and every field competed for one screen. Each step now asks one
// question and says which question it is (`WizardStepCounter`), and the steps
// that can fail carry their own error.
//
// # Why both wizards share one file
//
// They are one ceremony with one axis different: `accept` creates the
// membership and ends at the name gate, `join` installs a vault this identity
// already belongs to and has no owner code to collect. The phrase grid, the
// step counter and the action row are identical between them; only the
// step-list skeleton differs.
//
// # Secrets
//
// The phrase cells and the password live in this component's state and nowhere
// else, in no ref and at no module scope, so `onCancel` (the parent unmounts the
// wizard) discards them, and a successful submit clears the cells before the
// parent swaps the screen. There is no window-blur cover here, unlike
// vault-creation's phrase step, because nothing secret is revealed TO the user
// on this path: that flow DISPLAYS a phrase the device just generated, while
// this one takes a phrase the user already holds and types into input cells.
import {
  Fragment,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type ClipboardEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../primitives/Button";
import { DestructiveBanner } from "../DestructiveBanner";
import { PasswordCreateForm } from "../PasswordCreateForm";
import { MULTILINE_STYLE } from "../settings/panel-styles";
import {
  StepCard,
  StepHeading,
  StepLayout,
  StepProgress,
} from "../../screens/vault-creation/step-shell";
import { EnrollPhraseCredential, PHRASE_CELL_COUNT } from "./EnrollPhraseCredential";
import {
  personAcceptInvite,
  personJoinVault,
  type InviteSummary,
} from "../../lib/personAccount";
import { acceptInviteErrorKey } from "@myne/client-core/accept-invite";
import { memberJoinVaultErrorKey } from "@myne/client-core/join-member-vault";

const BODY_SMALL_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
};

const ACTIONS_ROW_STYLE: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
};

export interface InviteWizardProps {
  invite: InviteSummary;
  /** Leave the wizard without accepting; the caller returns to the invite list. */
  onCancel: () => void;
  /** The invite is accepted / the vault is installed on this device. */
  onAccepted: () => void;
}

function emptyPhraseCells(): string[] {
  return Array.from({ length: PHRASE_CELL_COUNT }, () => "");
}

/** Cell editing for the phrase grid, shared by both wizards. `onEdit` is where
 *  each flow clears its own error: an error about a phrase is stale the moment
 *  the phrase changes. */
function phraseCellHandlers(
  setCells: Dispatch<SetStateAction<string[]>>,
  onEdit: () => void,
) {
  return {
    onCellChange:
      (index: number) =>
      (event: ChangeEvent<HTMLInputElement>): void => {
        onEdit();
        setCells((cells) =>
          cells.map((cell, cellIndex) =>
            cellIndex === index ? event.target.value.replace(/\s+/g, "") : cell,
          ),
        );
      },
    onCellPaste:
      (index: number) =>
      (event: ClipboardEvent<HTMLInputElement>): void => {
        const tokens = event.clipboardData
          .getData("text")
          .split(/\s+/)
          .filter((token) => token.length > 0);
        // A one-word paste is a paste over one cell; only a multi-word paste is
        // spread across the row, which is why it takes over the event.
        if (tokens.length < 2) return;
        event.preventDefault();
        onEdit();
        setCells((cells) => {
          const next = [...cells];
          for (let i = 0; i < tokens.length && index + i < PHRASE_CELL_COUNT; i += 1) {
            next[index + i] = tokens[i];
          }
          return next;
        });
      },
  };
}

interface WizardStepCounterProps {
  /** Mount marker for E2E (curated-prop testid discipline, src/AGENTS.md). */
  testId: string;
  n: number;
  total: number;
  /** The step's own name, ALREADY translated by the caller, for the same
   *  reason `StepCounter`'s is: `check-i18n.mjs` proves a key exists by scanning
   *  for a static `t("literal")`, so each step spells its own key. */
  label: string;
}

/** The step counter for an invite wizard. Deliberately not `StepCounter`:
 *  that one resolves its position from vault-creation's `stepOrder.ts` and
 *  hard-codes `vaultCreation.stepIndicator`, and these steps are neither.
 *  Only the segments come through `StepProgress`. */
function WizardStepCounter({ testId, n, total, label }: WizardStepCounterProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid={testId}
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
    >
      <StepProgress n={n} total={total} />
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {t("identityHome.stepIndicator", { n, total, label })}
      </div>
    </div>
  );
}

/** The phrase step's body, identical in both wizards. */
function PhraseStepBody({
  baseId,
  hint,
  label,
  cells,
  handlers,
  gridTestId,
  cellTestId,
}: {
  baseId: string;
  hint: string;
  label: string;
  cells: string[];
  handlers: ReturnType<typeof phraseCellHandlers>;
  gridTestId: string;
  cellTestId: (index: number) => string;
}) {
  return (
    <StepCard>
      <p style={BODY_SMALL_STYLE}>{hint}</p>
      <EnrollPhraseCredential
        baseId={baseId}
        label={label}
        cells={cells}
        onCellChange={handlers.onCellChange}
        onCellPaste={handlers.onCellPaste}
        gridTestId={gridTestId}
        cellTestId={cellTestId}
      />
    </StepCard>
  );
}

/**
 * Accepting an invitation, in three steps: paste the owner's identity code,
 * enter the phrase, choose a password.
 *
 * The owner's code is a pinned input: the accepted group package is verified
 * against it, so a server that substitutes the owner's key is refused there.
 */
export function AcceptInviteWizard({ invite, onCancel, onAccepted }: InviteWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [ownerCode, setOwnerCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cells, setCells] = useState<string[]>(() => emptyPhraseCells());
  const clearError = () => setError(null);
  const cellHandlers = phraseCellHandlers(setCells, clearError);
  const phraseReady = cells.every((cell) => cell.length > 0);

  const goToPhrase = () => {
    clearError();
    setStep(1);
  };

  const submit = async (password: string) => {
    clearError();
    setSubmitting(true);
    try {
      await personAcceptInvite(
        invite.invite_id_hex,
        ownerCode.trim(),
        cells.join(" "),
        password,
      );
      // Drop the phrase before the parent swaps the screen (the name gate is
      // next); nothing else holds a copy.
      setCells(emptyPhraseCells());
      onAccepted();
    } catch (err) {
      // Surface WHICH failure it was, not only "could not be accepted": the
      // kinds are a closed enum and carry no secret (myne-md/myne#794).
      setError(t(acceptInviteErrorKey(err)));
      setSubmitting(false);
    }
  };

  return (
    <StepLayout>
      {/* The wrapper keeps the pre-wizard testid the E2E helpers wait on. It is
          `display: contents` so it does not become a box between StepLayout's
          flex column and the step's own children. */}
      <div data-testid="identity-home.accept-form" style={{ display: "contents" }}>
        {step === 0 ? (
          <Fragment key="owner">
            <WizardStepCounter
              testId="identity-home.accept-step"
              n={1}
              total={3}
              label={t("identityHome.stepVerifyOwner")}
            />
            <StepHeading>{t("identityHome.acceptHeading")}</StepHeading>
            <StepCard>
              <p style={BODY_SMALL_STYLE}>{t("identityHome.acceptHint")}</p>
              <textarea
                data-testid="identity-home.accept-owner-code"
                aria-label={t("identityHome.acceptOwnerCodeLabel")}
                value={ownerCode}
                onChange={(e) => {
                  setOwnerCode(e.target.value);
                  clearError();
                }}
                rows={3}
                style={MULTILINE_STYLE}
              />
            </StepCard>
            {error ? (
              <DestructiveBanner testId="identity-home.accept-error">{error}</DestructiveBanner>
            ) : null}
            <div style={ACTIONS_ROW_STYLE}>
              <Button
                variant="ghost"
                icon="arrow-left"
                data-testid="identity-home.accept-cancel"
                onClick={onCancel}
              >
                {t("common.cancel")}
              </Button>
              <div style={{ flex: 1 }} />
              <Button
                variant="primary"
                data-testid="identity-home.accept-continue"
                disabled={ownerCode.trim() === ""}
                onClick={goToPhrase}
              >
                {t("common.continue")}
              </Button>
            </div>
          </Fragment>
        ) : step === 1 ? (
          <Fragment key="phrase">
            <WizardStepCounter
              testId="identity-home.accept-step"
              n={2}
              total={3}
              label={t("identityHome.stepRecoveryPhrase")}
            />
            <StepHeading>{t("identityHome.phraseHeading")}</StepHeading>
            <PhraseStepBody
              baseId="identity-home-accept"
              hint={t("identityHome.acceptPhraseHint")}
              label={t("identityHome.acceptPhraseLabel")}
              cells={cells}
              handlers={cellHandlers}
              gridTestId="identity-home.accept-phrase-grid"
              cellTestId={(index) =>
                index === 0
                  ? "identity-home.accept-phrase"
                  : `identity-home.accept-phrase-cell-${index + 1}`
              }
            />
            <div style={ACTIONS_ROW_STYLE}>
              <Button
                variant="ghost"
                icon="arrow-left"
                data-testid="identity-home.accept-back"
                onClick={() => {
                  clearError();
                  setStep(0);
                }}
              >
                {t("common.back")}
              </Button>
              <div style={{ flex: 1 }} />
              <Button
                variant="primary"
                data-testid="identity-home.accept-continue"
                disabled={!phraseReady}
                onClick={() => {
                  clearError();
                  setStep(2);
                }}
              >
                {t("common.continue")}
              </Button>
            </div>
          </Fragment>
        ) : (
          <Fragment key="password">
            <WizardStepCounter
              testId="identity-home.accept-step"
              n={3}
              total={3}
              label={t("identityHome.stepDevicePassword")}
            />
            <StepHeading>{t("identityHome.passwordHeading")}</StepHeading>
            {/* The form's own submit IS the accept button, so the phrase and a
                password meeting the project floor are both satisfied in one
                gesture, and an accepted vault always carries a credential this
                device can open it with. The copy says plainly that this is not
                the owner's password. */}
            {/* The two password fields live in `PasswordCreateForm`, whose own state
                lasts one step: Back to the phrase and forward again remounts the
                form, so the password is retyped. Deliberate, and the opposite of
                the phrase cells, which are lifted into this component precisely
                because retyping 24 words is onerous. A password is short, and not
                holding it here means one fewer place it lives. Mobile differs
                (`mobile/src/app/flows/IdentityFlow.tsx` keeps it in flow state, so
                the same walk preserves it there), and the difference is a choice
                rather than an oversight. */}
            <PasswordCreateForm
              testIdPrefix="identity-home.accept"
              submitLabel={t("identityHome.acceptSubmit")}
              disabled={submitting || !phraseReady}
              autoFocus={false}
              fieldsCard
              errorBanner={
                error ? (
                  <DestructiveBanner testId="identity-home.accept-error">
                    {error}
                  </DestructiveBanner>
                ) : undefined
              }
              helperCopy={
                <p data-testid="identity-home.accept-password-note" style={BODY_SMALL_STYLE}>
                  {t("identityHome.acceptPasswordNote")}
                </p>
              }
              // No Back while the accept is in flight: the submit is an
              // Argon2id-bound call, and a late refusal has to land on the step
              // that renders the banner. Mobile blocks the whole step for the same
              // window (`BlockingOverlay`); this is the narrower desktop form of
              // it, and it leaves nothing unreachable because the submit button is
              // disabled for exactly as long.
              secondaryAction={
                submitting
                  ? undefined
                  : {
                      label: t("common.back"),
                      icon: "arrow-left",
                      onClick: () => {
                        clearError();
                        setStep(1);
                      },
                    }
              }
              onSubmit={submit}
            />
          </Fragment>
        )}
      </div>
    </StepLayout>
  );
}

/**
 * Installing an already-shared vault on a second device, in two steps: enter
 * the phrase, choose a password.
 *
 * There is deliberately NO owner-code step here, and the absence is
 * load-bearing rather than a simplification: the owner this device verifies the
 * group package against is the one its own per-`(person, vault)` profile
 * already pins (`decisions/protocol/0675`). A field would let whatever is
 * pasted into it become the trust anchor, which is the one thing the pin exists
 * to prevent.
 */
export function JoinVaultWizard({ invite, onCancel, onAccepted }: InviteWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<0 | 1>(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cells, setCells] = useState<string[]>(() => emptyPhraseCells());
  const clearError = () => setError(null);
  const cellHandlers = phraseCellHandlers(setCells, clearError);
  const phraseReady = cells.every((cell) => cell.length > 0);

  const submit = async (password: string) => {
    clearError();
    setSubmitting(true);
    try {
      await personJoinVault(
        invite.invite_id_hex,
        invite.vault_account_hash_hex,
        cells.join(" "),
        password,
      );
      setCells(emptyPhraseCells());
      // Straight to the editor: a join installs a vault this identity is
      // ALREADY a member of, so there is no name to set and no gate to pass.
      // The accept path owes one because it is what creates a member; this
      // path must not write a name, or a second device would silently re-name
      // a person its first device had already named (myne-md/myne#852 task 7).
      onAccepted();
    } catch (err) {
      setError(t(memberJoinVaultErrorKey(err)));
      setSubmitting(false);
    }
  };

  return (
    <StepLayout>
      <div data-testid="identity-home.join-form" style={{ display: "contents" }}>
        {step === 0 ? (
          <Fragment key="phrase">
            <WizardStepCounter
              testId="identity-home.join-step"
              n={1}
              total={2}
              label={t("identityHome.stepRecoveryPhrase")}
            />
            <StepHeading>{t("identityHome.phraseHeading")}</StepHeading>
            <PhraseStepBody
              baseId="identity-home-join"
              hint={t("identityHome.joinHint")}
              label={t("identityHome.joinPhraseLabel")}
              cells={cells}
              handlers={cellHandlers}
              gridTestId="identity-home.join-phrase-grid"
              cellTestId={(index) =>
                index === 0
                  ? "identity-home.join-phrase"
                  : `identity-home.join-phrase-cell-${index + 1}`
              }
            />
            <div style={ACTIONS_ROW_STYLE}>
              <Button
                variant="ghost"
                icon="arrow-left"
                data-testid="identity-home.join-cancel"
                onClick={onCancel}
              >
                {t("common.cancel")}
              </Button>
              <div style={{ flex: 1 }} />
              <Button
                variant="primary"
                data-testid="identity-home.join-continue"
                disabled={!phraseReady}
                onClick={() => {
                  clearError();
                  setStep(1);
                }}
              >
                {t("common.continue")}
              </Button>
            </div>
          </Fragment>
        ) : (
          <Fragment key="password">
            <WizardStepCounter
              testId="identity-home.join-step"
              n={2}
              total={2}
              label={t("identityHome.stepDevicePassword")}
            />
            <StepHeading>{t("identityHome.passwordHeading")}</StepHeading>
            <PasswordCreateForm
              testIdPrefix="identity-home.join"
              submitLabel={t("identityHome.joinSubmit")}
              disabled={submitting || !phraseReady}
              autoFocus={false}
              fieldsCard
              errorBanner={
                error ? (
                  <DestructiveBanner testId="identity-home.join-error">{error}</DestructiveBanner>
                ) : undefined
              }
              helperCopy={
                <p data-testid="identity-home.join-password-note" style={BODY_SMALL_STYLE}>
                  {t("identityHome.joinPasswordNote")}
                </p>
              }
              // No Back while the join is in flight, for the reason the accept
              // gives beside its own.
              secondaryAction={
                submitting
                  ? undefined
                  : {
                      label: t("common.back"),
                      icon: "arrow-left",
                      onClick: () => {
                        clearError();
                        setStep(0);
                      },
                    }
              }
              onSubmit={submit}
            />
          </Fragment>
        )}
      </div>
    </StepLayout>
  );
}
