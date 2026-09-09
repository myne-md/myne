// The per-provider consent screen (myne-md/myne#456).
//
// **This screen is what closes SYNC-22.** The provider selection, the model and
// the API key all arrive by sync, so a phone enrolled into a vault that was
// configured on a laptop already holds everything a request needs. What it does
// not hold is permission: `ai_provider_consent` is device-local, and this is the
// only thing that writes it here.
//
// **The accepting action cannot be reached without the disclosure on screen.**
// Not "the disclosure is above the button": the button is rendered by this
// component and only by this component, so there is no route to acceptance that
// skips the text. What it carries is therefore the WHOLE disclosure, never a
// summary with the detail one tap away: a confirm sheet saying "this sends your
// notes to a third party: details" would be the shape this rule forbids.
//
// **Dismissing is declining.** The back gesture and Cancel both call `onCancel`,
// which stores nothing. There is no dismissal that leaves a consent recorded.
//
// **Nothing here decides anything.** Accepting calls back to the caller, which
// writes the consent; the host re-reads every precondition at request time
// (`provider_gate.rs`) and would refuse regardless of what this screen did. The
// screen is the asking, not the enforcement.
//
// Copy discipline: every clause comes from `@myne/copy` verbatim and is never
// i18n'd, because the exact wording is a threat-model-bounded claim and a
// translation is a re-derivation nobody reviewed. Only the chrome is translated.
// The clauses are byte-identical to the desktop screen's by construction, which
// is the whole reason they live in that package rather than in either client.

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
  consentCannotVerify,
  consentToWhom,
  providerLabelOf,
} from "@myne/copy";
// Imported directly rather than through `./index`, and not as a style choice: a
// component reaching for its own barrel pulls in every sibling the barrel
// exports, which here means the sync banners and their `@myne/sync-staleness`
// alias. That turned a focused unit test of this file into a module-resolution
// failure with nothing to do with consent.
import { Button } from "./Button";

// Tokens rather than literals throughout, and not as a style preference: an
// inline numeric literal outranks every stylesheet, so it is unreachable to a
// custom theme permanently. `scripts/check-token-adoption.mjs` is the ratchet,
// and a new file starts at zero: the honest way to keep it there is to write
// no literals rather than to re-record eight.
const CLAUSE_LABEL: CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--line-3)",
};

const CLAUSE_BODY: CSSProperties = {
  marginTop: "var(--space-1)",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-relaxed)",
  color: "var(--fg-2)",
};

function Clause({
  label,
  body,
  testId,
}: {
  label: string;
  body: string;
  testId: string;
}) {
  return (
    <div style={{ marginTop: "var(--space-4)" }}>
      <div style={CLAUSE_LABEL}>{label}</div>
      <div data-testid={testId} style={CLAUSE_BODY}>
        {body}
      </div>
    </div>
  );
}

export function AiConsentScreen({
  provider,
  onAccept,
  onCancel,
}: {
  /** The provider's wire name, e.g. `openrouter`. */
  provider: string;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  // The proper noun, from the shared table. A consent screen that cannot name
  // the recipient is not consent, so this is not allowed to be a wire value.
  const name = providerLabelOf(provider) ?? provider;

  return (
    <div
      data-testid="ai-consent.screen"
      role="dialog"
      aria-modal="true"
      style={{
        // **Fixed and over everything, which is what the header claims.** It
        // mounted as an ordinary sibling of the AI panel inside the settings
        // sheet's scroll container, so it rendered a screenful BELOW the panel
        // with the scroll position unmoved: tapping the row that opens it
        // produced no visible change, and the provider toggles, the key field
        // and Revoke stayed live above it. "The accepting action cannot be
        // reached without the disclosure on screen" was then false in the one
        // direction that matters, since the panel's own controls were the thing
        // still reachable.
        //
        // The flow test could not see it: Playwright's `toBeVisible` is true of
        // any non-empty box and `.click()` scrolls to its target first.
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--bg-1)",
      }}
    >
      {/* The clauses scroll; the actions do not. A screen whose buttons scroll
          out of view reads as unanswerable, and on a phone that is not a
          hypothetical: seven clauses do not fit. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "var(--space-0) var(--space-1) var(--space-3)",
        }}
      >
        <h2
          data-testid="ai-consent.title"
          style={{
            margin: "var(--space-0)",
            fontSize: "var(--text-lg)",
            fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
            color: "var(--fg-1)",
          }}
        >
          {t("settings.ai.consent.title", { provider: name })}
        </h2>

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
          body={consentToWhom(name)}
          testId="ai-consent.who"
        />
        {/* The clause a consent screen usually omits, and the one that makes the
            other three honest: Myne may state what it sends and to whom, never
            what the far side retains. */}
        <Clause
          label={t("settings.ai.consent.cannotVerifyLabel")}
          body={consentCannotVerify(name)}
          testId="ai-consent.cannot-verify"
        />
        <Clause
          label={t("settings.ai.consent.revokeLabel")}
          body={CONSENT_HOW_TO_REVOKE}
          testId="ai-consent.revoke"
        />
        {/* The clause this screen exists for. On a phone it is the load-bearing
            one: the key arrived by sync, and this says the approval did not. */}
        <Clause
          label={t("settings.ai.consent.scopeLabel")}
          body={CONSENT_DEVICE_SCOPE}
          testId="ai-consent.scope"
        />
        <Clause
          label={t("settings.ai.consent.connectionLabel")}
          body={CONSENT_DIRECT_CONNECTION}
          testId="ai-consent.connection"
        />
        <Clause
          label={t("settings.ai.consent.excludedLabel")}
          body={CONSENT_EXCLUDED_FOLDERS}
          testId="ai-consent.excluded"
        />

        {/* The A7 residual, the eighth element the desktop screen has always
            rendered and this one omitted (myne-md/myne#456, found by review).
            It applies to a phone in full, and this same change is the evidence:
            it fixed a lock teardown because the mobile process holds the
            plaintext provider key and note-derived text in app memory. It was
            missing because the sentence lived in `src/lib/load-bearing-copy.ts`,
            which mobile does not compile; it is in `@myne/copy` now, so the
            byte-identity this file's header claims by construction is one. */}
        <p data-testid="ai-consent.residual" style={CLAUSE_BODY}>
          {AI_TRUST_A7_RESIDUAL}
        </p>
      </div>

      <div
        style={{
          flex: "none",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
          padding:
            "var(--space-3) var(--space-1) calc(var(--space-3) + env(safe-area-inset-bottom, 0px))",
          borderTop: "1px solid var(--line-1)",
        }}
      >
        {/* The accepting action names the recipient. A button that said "Accept"
            would be one the user could press without having read who it is
            about. */}
        <Button data-testid="ai-consent.accept" onClick={onAccept}>
          {t("settings.ai.consent.accept", { provider: name })}
        </Button>
        <Button variant="secondary" data-testid="ai-consent.cancel" onClick={onCancel}>
          {t("settings.ai.consent.cancel")}
        </Button>
      </div>
    </div>
  );
}
