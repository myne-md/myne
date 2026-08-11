// The one-time per-provider consent screen (ai-remote-providers myne#415
// task 13, SYNC-13).
//
// **The accepting action cannot be reached without the disclosure on screen.**
// Not "the disclosure is above the button" — the button is rendered by this
// component and only by this component, so there is no route to acceptance
// that skips the text. That is why it is a screen rather than a confirm dialog
// with a summary.
//
// **No "don't ask again" checkbox**, because it is already once-only: consent
// is recorded per provider and the panel routes through here exactly when the
// stored consent does not name the provider being selected. A checkbox would
// be offering to skip something that does not repeat.
//
// **Nothing here decides anything.** Accepting calls back to the panel, which
// writes the consent; the host re-reads all five preconditions at request time
// (`provider_gate.rs`) and would refuse regardless of what this screen did.
// The screen is the asking, not the enforcement — the same discipline the AI
// panel already follows.
//
// Copy discipline: every sentence comes from `load-bearing-copy.ts` verbatim
// and is never i18n'd (`src/CLAUDE.md`), because the exact wording is a
// threat-model-bounded claim. Only the chrome around it is translated.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import {
  AI_TRUST_A7_RESIDUAL,
  CONSENT_ACCOUNT_SCOPE,
  CONSENT_HOW_TO_REVOKE,
  CONSENT_WHAT_LEAVES,
  CONSENT_WHEN_IT_LEAVES,
  aiTrustHeadline,
  consentCannotVerify,
  consentToWhom,
} from "../../lib/load-bearing-copy";
import { Button } from "../primitives/Button";
import { BLOCK_STYLE, HELPER_STYLE, LABEL_STYLE } from "./panel-styles";

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
};

const CLAUSE_STYLE: CSSProperties = {
  ...HELPER_STYLE,
  lineHeight: 1.55,
  marginTop: "var(--space-1)",
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  marginTop: "var(--space-3)",
  justifyContent: "flex-end",
};

interface AiProviderConsentProps {
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
  providerLabel,
  onAccept,
  onCancel,
}: AiProviderConsentProps) {
  const { t } = useTranslation();

  return (
    <div data-testid="ai-consent.screen" style={BLOCK_STYLE}>
      <h3 style={TITLE_STYLE}>
        {t("settings.ai.consent.title", { provider: providerLabel })}
      </h3>
      {/* The state headline for the remote case, verbatim — the same sentence
          the panel will show afterwards, so the screen and the steady state
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
      {/* The clause a consent screen usually omits, and the one that makes the
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
        body={CONSENT_ACCOUNT_SCOPE}
        testId="ai-consent.scope"
      />

      <p data-testid="ai-consent.residual" style={CLAUSE_STYLE}>
        {AI_TRUST_A7_RESIDUAL}
      </p>

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
    </div>
  );
}
