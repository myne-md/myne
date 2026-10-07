// First-run safety briefing — the pre-vault-create contract (MYND-114).
//
// Inserted ahead of PasswordStep on the FIRST-RUN (welcome-entry) create
// flow only (picker / switcher "create another" skip it — the user has
// signed the contract once). It is a contract, NOT a blocker: three plain
// statements about the recovery model, each with an opt-in "Why?"
// disclosure and its own acknowledgement checkbox. "Continue to vault
// creation" stays disabled until all three are acknowledged.
//
// Tone is load-bearing here — PRODUCT.md "honest, not alarming". No red
// warning banners, no alarm icons, no hype. The gravity is carried by
// plain typography on calm `--paper-2` cards. Copy is bounded by the
// threat model (vision.md "What Myne Is Not" — no email recovery, ever)
// and echoes the normative fixed string inside statement 2's "Why?".
//
// No reducer state: the per-statement acknowledgements and "Why?"
// expansions live in local component state. The step is never re-entered
// via back-navigation — "Back" exits the flow through the reprobe path
// (App.tsx `onBack`), the same as PasswordStep's Back — so a fresh mount
// (empty acknowledgements) on re-entry is correct.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { LOST_BOTH_SECRETS_SENTENCE } from "../../lib/load-bearing-copy";
import { StepCard, StepEyebrow, StepHeading, StepLayout } from "./step-shell";

interface BriefingStepProps {
  /** Exit the create flow (reprobe → welcome at 0 vaults). */
  onBack: () => void;
  /** All three acknowledged + Continue clicked → dispatch BRIEFING_ACKED. */
  onContinue: () => void;
}

interface BriefingStatement {
  /** Stable key for local state + the `data-ack-id` E2E discriminator. */
  id: string;
  /** The headline truth (bold). */
  statement: string;
  /** Opt-in "Why?" expansion — kept within threat-model guarantees. */
  why: string;
  /** Concrete acknowledgement (restates so ticking requires reading). */
  ackLabel: string;
}

/** Stable statement ids — the `data-ack-id` E2E discriminator + local-state
 *  keys. NOT user-facing; the copy is resolved per-render via i18n keyed on
 *  these ids so a language switch re-renders the labels. */
const STATEMENT_IDS = ["no-store", "phrase-backup", "no-email"] as const;

export function BriefingStep({ onBack, onContinue }: BriefingStepProps) {
  const { t } = useTranslation();
  const [acked, setAcked] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Resolved at render time (never frozen at import) so switching language
  // re-renders the briefing copy. The `phrase-backup` "Why?" embeds the
  // load-bearing `LOST_BOTH_SECRETS_SENTENCE` verbatim via interpolation —
  // the sentence itself is never translated (privacy property).
  const STATEMENTS: readonly BriefingStatement[] = STATEMENT_IDS.map((id) => ({
    id,
    statement: t(`vaultCreation.briefing.statements.${id}.statement`),
    why:
      id === "phrase-backup"
        ? t(`vaultCreation.briefing.statements.${id}.why`, {
            lostBothSecrets: LOST_BOTH_SECRETS_SENTENCE,
          })
        : t(`vaultCreation.briefing.statements.${id}.why`),
    ackLabel: t(`vaultCreation.briefing.statements.${id}.ackLabel`),
  }));

  const allAcknowledged = STATEMENTS.every((s) => acked[s.id]);

  return (
    <StepLayout width={480}>
      {/* Calm, non-numbered eyebrow — this is a pre-step briefing, not
          "STEP 1 OF 4" (that label belongs to PasswordStep). No icon: an
          alarm glyph would read as a warning, which the tone forbids.
          Doubles as the step's mount marker (`create.briefing`). */}
      <StepEyebrow testId="create.briefing">
        {t("vaultCreation.briefing.eyebrow")}
      </StepEyebrow>
      <StepHeading>{t("vaultCreation.briefing.heading")}</StepHeading>

      <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}>
        {t("vaultCreation.briefing.intro")}
      </div>

      {/* One card, three rows (the Welcome card's shape): the statements read
          as one contract rather than three alerts, and a row is ticked where
          it is read. */}
      <StepCard variant="rows">
        {STATEMENTS.map((s, i) => {
          const isExpanded = !!expanded[s.id];
          return (
            <div
              key={s.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-2)",
                padding: "var(--space-4) 0",
                borderBottom:
                  i === STATEMENTS.length - 1 ? undefined : "1px solid var(--line-1)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "var(--space-3)",
                }}
              >
                <div
                  style={{
                    flex: 1,
                    fontSize: "var(--text-base)",
                    fontWeight: "var(--weight-medium)",
                    lineHeight: 1.4,
                    color: "var(--fg-1)",
                  }}
                >
                  {s.statement}
                </div>
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() =>
                    setExpanded((prev) => ({ ...prev, [s.id]: !prev[s.id] }))
                  }
                  data-testid="create.briefing-why"
                  data-ack-id={s.id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    flexShrink: 0,
                    padding: 0,
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    color: "var(--fg-3)",
                    fontFamily: "var(--font-sans)",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  {t("vaultCreation.briefing.why")}
                  <Icon name={isExpanded ? "chevron-up" : "chevron-down"} size={14} />
                </button>
              </div>

              {isExpanded && (
                <div
                  data-testid="create.briefing-why-text"
                  data-ack-id={s.id}
                  style={{
                    fontSize: "var(--text-sm)",
                    lineHeight: 1.6,
                    color: "var(--fg-2)",
                  }}
                >
                  {s.why}
                </div>
              )}

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  cursor: "pointer",
                  fontSize: "var(--text-sm)",
                  lineHeight: 1.5,
                  color: acked[s.id] ? "var(--fg-1)" : "var(--fg-2)",
                }}
              >
                <input
                  type="checkbox"
                  checked={!!acked[s.id]}
                  onChange={(e) =>
                    setAcked((prev) => ({ ...prev, [s.id]: e.target.checked }))
                  }
                  style={{ margin: 0, accentColor: "var(--accent)" }}
                  data-testid="create.briefing-ack"
                  data-ack-id={s.id}
                />
                {s.ackLabel}
              </label>
            </div>
          );
        })}
      </StepCard>

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <Button
          variant="ghost"
          onClick={onBack}
          icon="arrow-left"
          data-testid="create.briefing-back"
        >
          {t("vaultCreation.briefing.back")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button
          variant="primary"
          onClick={onContinue}
          disabled={!allAcknowledged}
          data-testid="create.briefing-continue"
        >
          {t("vaultCreation.briefing.continue")}
        </Button>
      </div>
    </StepLayout>
  );
}
