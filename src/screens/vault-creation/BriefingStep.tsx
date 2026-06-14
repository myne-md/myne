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
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { LOST_BOTH_SECRETS_SENTENCE } from "../../lib/load-bearing-copy";
import { StepEyebrow, StepHeading, StepLayout } from "./step-shell";

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

const STATEMENTS: readonly BriefingStatement[] = [
  {
    id: "no-store",
    statement: "Your password unlocks your vault. We don't store it.",
    why: "Your password is the input to the key that decrypts your notes. It never leaves this device, and nothing on our servers can reproduce it. That's what keeps your notes private — and why we can't reset it for you.",
    ackLabel: "I understand Myne can't recover my password.",
  },
  {
    id: "phrase-backup",
    statement: "Your recovery phrase is your only backup.",
    // Embeds the shared normative sentence (stated plainly, once) between
    // a lead-in and the practical advice.
    why: `If you forget your password, the 24-word recovery phrase is the one way back in. ${LOST_BOTH_SECRETS_SENTENCE} Write the phrase down and keep it somewhere safe.`,
    ackLabel: "I understand my recovery phrase is the only backup.",
  },
  {
    id: "no-email",
    statement: "There is no email recovery. There never will be.",
    why: "We never ask for your email, so there's no reset link and no account for support to unlock. This isn't a missing feature — it's the guarantee. Email recovery would mean we could read your notes, and Myne is built so we can't.",
    ackLabel: "I understand there is no email recovery.",
  },
];

export function BriefingStep({ onBack, onContinue }: BriefingStepProps) {
  const [acked, setAcked] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const allAcknowledged = STATEMENTS.every((s) => acked[s.id]);

  return (
    <StepLayout width={480}>
      {/* Calm, non-numbered eyebrow — this is a pre-step briefing, not
          "STEP 1 OF 4" (that label belongs to PasswordStep). No icon: an
          alarm glyph would read as a warning, which the tone forbids.
          Doubles as the step's mount marker (`create.briefing`). */}
      <StepEyebrow testId="create.briefing">
        Before you create your vault
      </StepEyebrow>
      <StepHeading>Before you create your vault</StepHeading>

      <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--fg-2)" }}>
        Myne encrypts your notes so that only you can open them. Three things
        follow from that — read them, then continue.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {STATEMENTS.map((s) => {
          const isExpanded = !!expanded[s.id];
          return (
            <div
              key={s.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                padding: 16,
                background: "var(--paper-2)",
                border: "1px solid var(--line-1)",
                borderRadius: 6,
              }}
            >
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
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
                  gap: 4,
                  alignSelf: "flex-start",
                  padding: 0,
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  color: "var(--accent)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                Why?
                <Icon name={isExpanded ? "chevron-up" : "chevron-down"} size={16} />
              </button>

              {isExpanded && (
                <div
                  data-testid="create.briefing-why-text"
                  data-ack-id={s.id}
                  style={{ fontSize: 13, lineHeight: 1.6, color: "var(--fg-2)" }}
                >
                  {s.why}
                </div>
              )}

              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={!!acked[s.id]}
                  onChange={(e) =>
                    setAcked((prev) => ({ ...prev, [s.id]: e.target.checked }))
                  }
                  style={{ marginTop: 2, accentColor: "var(--accent)" }}
                  data-testid="create.briefing-ack"
                  data-ack-id={s.id}
                />
                <div
                  style={{ fontSize: 13, lineHeight: 1.5, color: "var(--fg-1)" }}
                >
                  {s.ackLabel}
                </div>
              </label>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Button
          variant="ghost"
          onClick={onBack}
          icon="arrow-left"
          data-testid="create.briefing-back"
        >
          Back
        </Button>
        <div style={{ flex: 1 }} />
        <Button
          variant="primary"
          onClick={onContinue}
          disabled={!allAcknowledged}
          data-testid="create.briefing-continue"
        >
          Continue to vault creation
        </Button>
      </div>
    </StepLayout>
  );
}
