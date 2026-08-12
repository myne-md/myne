// The one-time beta-terms screen, shown before this device first turns sync on
// (operations#15).
//
// **The accepting action cannot be reached without the terms on screen.** Not
// "the terms are above the button" — the button is rendered by this component
// and only by this component, so there is no route to acceptance that skips the
// text. That is the rule `AiProviderConsent.tsx` states for the AI provider
// consent, and it is the same rule here for the same reason.
//
// **No "don't ask again" checkbox**, because it is already once-only: the
// accepted version is recorded device-local and this screen appears exactly
// when it does not match the version the build ships. A checkbox would be
// offering to skip something that does not repeat.
//
// **Nothing here decides anything.** Accepting calls back to the caller, which
// records it; the caller is also what proceeds with enrolment. The screen is
// the asking, not the enforcement.
//
// Copy discipline: the four clauses come from `load-bearing-copy.ts` verbatim
// and are never i18n'd (`src/CLAUDE.md`), because each is a bounded claim — a
// translation that softened "cannot be recovered" into "may be difficult to
// recover" would be a good translation and a false statement. Only the chrome
// around them is translated.
//
// It links the published terms rather than reproducing them: these four
// clauses are what a person must have read before sync starts carrying their
// notes, and the full text is a page, not a dialog.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import {
  BETA_TERMS_DATA_LOSS,
  BETA_TERMS_WHAT_HAPPENS_NEXT,
  BETA_TERMS_WHAT_THIS_IS,
  BETA_TERMS_WHAT_WE_CAN_SEE,
} from "../../lib/load-bearing-copy";
import { legalUrl } from "../../lib/legal-urls";
import { openUrl } from "../../platform/opener";
import { Button } from "../primitives/Button";
import { BLOCK_STYLE, HELPER_STYLE, LABEL_STYLE } from "../settings/panel-styles";

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

const LINK_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--accent)",
  textDecoration: "underline",
  background: "none",
  border: 0,
  padding: 0,
  cursor: "pointer",
  fontFamily: "inherit",
  alignSelf: "flex-start",
  marginTop: "var(--space-3)",
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  marginTop: "var(--space-3)",
  justifyContent: "flex-end",
};

interface BetaTermsConsentProps {
  onAccept: () => void;
  onCancel: () => void;
}

/** One labelled clause. A heading per clause so the four are visibly four,
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

export function BetaTermsConsent({ onAccept, onCancel }: BetaTermsConsentProps) {
  const { t, i18n } = useTranslation();

  return (
    <div style={BLOCK_STYLE} data-testid="sync.beta-terms">
      <h3 style={TITLE_STYLE}>{t("sync.betaTerms.title")}</h3>
      <p style={{ ...HELPER_STYLE, marginTop: "var(--space-1)" }}>
        {t("sync.betaTerms.intro")}
      </p>

      <Clause
        label={t("sync.betaTerms.whatThisIsLabel")}
        body={BETA_TERMS_WHAT_THIS_IS}
        testId="sync.beta-terms.what-this-is"
      />
      <Clause
        label={t("sync.betaTerms.dataLossLabel")}
        body={BETA_TERMS_DATA_LOSS}
        testId="sync.beta-terms.data-loss"
      />
      <Clause
        label={t("sync.betaTerms.whatHappensNextLabel")}
        body={BETA_TERMS_WHAT_HAPPENS_NEXT}
        testId="sync.beta-terms.what-happens-next"
      />
      <Clause
        label={t("sync.betaTerms.whatWeCanSeeLabel")}
        body={BETA_TERMS_WHAT_WE_CAN_SEE}
        testId="sync.beta-terms.what-we-can-see"
      />

      <button
        type="button"
        style={LINK_STYLE}
        data-testid="sync.beta-terms.full-text"
        onClick={() => {
          openUrl(legalUrl("terms", i18n.language)).catch((err) => {
            if (import.meta.env.DEV) {
              console.warn("BetaTermsConsent: openUrl(terms) rejected", err);
            }
          });
        }}
      >
        {t("sync.betaTerms.readFull")} ↗
      </button>

      <div style={ACTIONS_STYLE}>
        <Button variant="ghost" onClick={onCancel} data-testid="sync.beta-terms.cancel">
          {t("common.cancel")}
        </Button>
        <Button variant="primary" onClick={onAccept} data-testid="sync.beta-terms.accept">
          {t("sync.betaTerms.accept")}
        </Button>
      </div>
    </div>
  );
}
