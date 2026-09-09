// The one-time per-provider consent dialog (ai-remote-providers myne#415
// task 13, SYNC-13).
//
// **The accepting action cannot be reached without the disclosure on screen.**
// Not "the disclosure is above the button" — the button is rendered by this
// component and only by this component, so there is no route to acceptance
// that skips the text. What the dialog carries is therefore the WHOLE
// disclosure, never a summary with the detail one click away: a confirm box
// that says "this sends your notes to a third party — details" would be the
// shape this rule exists to forbid. The six clauses and the accepting button
// live in one container, and the container is what opens.
//
// **Dismissing is declining.** Esc, the backdrop and the × all call `onCancel`,
// which stores nothing — the panel writes the provider only from `onAccept`.
// So there is no dismissal that leaves a provider selected, and no dismissal
// that has to be undone.
//
// **No "don't ask again" checkbox**, because it is already once-only: consent
// is recorded per provider and the panel routes through here exactly when the
// stored consent does not name the provider being selected. A checkbox would
// be offering to skip something that does not repeat.
//
// **Nothing here decides anything.** Accepting calls back to the panel, which
// writes the consent; the host re-reads all four preconditions at request time
// (`provider_gate.rs`) and would refuse regardless of what this dialog did.
// The dialog is the asking, not the enforcement — the same discipline the AI
// panel already follows.
//
// Copy discipline: every sentence comes from `load-bearing-copy.ts` verbatim
// and is never i18n'd (`src/CLAUDE.md`), because the exact wording is a
// threat-model-bounded claim. Only the chrome around it is translated.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import {
  AI_TRUST_A7_RESIDUAL,
  CONSENT_DEVICE_SCOPE,
  CONSENT_DIRECT_CONNECTION,
  CONSENT_EXCLUDED_FOLDERS,
  CONSENT_HOW_TO_REVOKE,
  CONSENT_WHAT_LEAVES,
  CONSENT_WHEN_IT_LEAVES,
  aiTrustHeadline,
  consentCannotVerify,
  consentToWhom,
} from "../../lib/load-bearing-copy";
import { Button } from "../primitives/Button";
import { ModalShell } from "../primitives/ModalShell";
import { HELPER_STYLE, LABEL_STYLE } from "./panel-styles";

const CLAUSE_STYLE: CSSProperties = {
  ...HELPER_STYLE,
  lineHeight: 1.55,
  marginTop: "var(--space-1)",
};

/** The clauses scroll; the actions do not. A dialog whose buttons scroll out
 *  of view reads as unanswerable. */
const SCROLL_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-5)",
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  justifyContent: "flex-end",
  flex: "0 0 auto",
  padding: "var(--space-4) var(--space-5)",
  borderTop: "1px solid var(--line-1)",
};

interface AiProviderConsentProps {
  /** Whether the dialog is up. Closed renders nothing. */
  open: boolean;
  /** The provider being selected, as the user reads it. */
  providerLabel: string;
  onAccept: () => void;
  onCancel: () => void;
}

/** One labelled clause. A heading per question so the four are visibly four,
 *  rather than a paragraph a reader can skim past. */
function Clause(props: { label: string; body: string; testId: string }) {
  return (
    <div style={{ marginTop: "var(--space-2)" }}>
      <label style={LABEL_STYLE}>{props.label}</label>
      <p data-testid={props.testId} style={CLAUSE_STYLE}>
        {props.body}
      </p>
    </div>
  );
}

export function AiProviderConsent({
  open,
  providerLabel,
  onAccept,
  onCancel,
}: AiProviderConsentProps) {
  const { t } = useTranslation();

  return (
    <ModalShell
      open={open}
      // Names the provider in the title bar, so the recipient is on screen
      // even before the clauses are read.
      title={t("settings.ai.consent.title", { provider: providerLabel })}
      onClose={onCancel}
      labelId="ai-consent-title"
      closeLabel={t("common.close")}
      width={560}
      testId="ai-consent.screen"
      // No `zIndex` override: this opens from inside the Settings modal, whose
      // own fixed backdrop is a stacking context, so the dialog already paints
      // above it. The raised level is for surfaces that arrive UNSOLICITED.
    >
      <div style={SCROLL_STYLE}>
        {/* The state headline for the remote case, verbatim — the same sentence
            the panel will show afterwards, so the dialog and the steady state
            cannot disagree about what was agreed to. */}
        <p data-testid="ai-consent.headline" style={{ ...LABEL_STYLE, lineHeight: 1.5 }}>
          {aiTrustHeadline({ kind: "remote", provider: providerLabel })}
        </p>

        <Clause
          label={t("settings.ai.consent.whatLabel")}
          body={CONSENT_WHAT_LEAVES}
          testId="ai-consent.what"
        />
        <Clause
          label={t("settings.ai.consent.whenLabel")}
          body={CONSENT_WHEN_IT_LEAVES}
          testId="ai-consent.when"
        />
        <Clause
          label={t("settings.ai.consent.whoLabel")}
          body={consentToWhom(providerLabel)}
          testId="ai-consent.who"
        />
        {/* The clause a consent dialog usually omits, and the one that makes the
            other three honest (A17). */}
        <Clause
          label={t("settings.ai.consent.cannotVerifyLabel")}
          body={consentCannotVerify(providerLabel)}
          testId="ai-consent.cannot-verify"
        />
        <Clause
          label={t("settings.ai.consent.revokeLabel")}
          body={CONSENT_HOW_TO_REVOKE}
          testId="ai-consent.revoke"
        />
        <Clause
          label={t("settings.ai.consent.scopeLabel")}
          body={CONSENT_DEVICE_SCOPE}
          testId="ai-consent.scope"
        />
        {/* HOW it travels. Added by myne-md/myne#456 and stated nowhere else: a
            reader who has seen the Tor routing option elsewhere in the product
            would reasonably assume it applies to this too, and it does not. */}
        <Clause
          label={t("settings.ai.consent.connectionLabel")}
          body={CONSENT_DIRECT_CONNECTION}
          testId="ai-consent.connection"
        />
        {/* WHAT NEW READS NEVER TOUCH. The one clause about the content control
            rather than the disclosure (myne-md/myne#675): the excluded-folders
            list withholds whole folders from new reads under the agreement
            above, and it is the same list the command-line client honors. */}
        <Clause
          label={t("settings.ai.consent.excludedLabel")}
          body={CONSENT_EXCLUDED_FOLDERS}
          testId="ai-consent.excluded"
        />

        <p data-testid="ai-consent.residual" style={CLAUSE_STYLE}>
          {AI_TRUST_A7_RESIDUAL}
        </p>
      </div>

      <div style={ACTIONS_STYLE}>
        <Button
          variant="secondary"
          data-testid="ai-consent.cancel"
          onClick={onCancel}
        >
          {t("settings.ai.consent.cancel")}
        </Button>
        {/* Explicit and specific to the named provider — never a bare "OK". */}
        <Button variant="primary" data-testid="ai-consent.accept" onClick={onAccept}>
          {t("settings.ai.consent.accept", { provider: providerLabel })}
        </Button>
      </div>
    </ModalShell>
  );
}
