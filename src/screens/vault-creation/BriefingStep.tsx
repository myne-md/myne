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

import { useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Checkbox } from "../../components/primitives/Checkbox";
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
          // The curve follows the direction, as `DisclosureWrapper` in NoteList
          // does: `--ease-out` leads an entrance, `--ease-standard` an exit.
          // One curve for both would make the closing motion start slow, which
          // is the phase the eye is already watching.
          const whyEasing = isExpanded
            ? "var(--ease-out)"
            : "var(--ease-standard)";
          return (
            <div
              key={s.id}
              style={{
                display: "flex",
                flexDirection: "column",
                // Explicit child margins instead of a flex `gap`: a collapsing
                // body stays MOUNTED for the length of its exit transition,
                // and a zero-height flex item still claims both gaps, so the
                // acknowledgement label would snap up 8px when the node
                // finally unmounts. With the spacing inside the clipped box
                // (see WhyDisclosure) a collapsing body occupies exactly the
                // space of an absent one.
                gap: 0,
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
                  <Icon
                    name="chevron-down"
                    size={14}
                    style={{
                      // One glyph turned over in place (myne-md/myne#868):
                      // swapping chevron-up/chevron-down remounts the node,
                      // and a remount cannot animate.
                      transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                      transition: `transform var(--duration-base) ${whyEasing}`,
                    }}
                  />
                </button>
              </div>

              <WhyDisclosure open={isExpanded}>
                <div
                  data-testid="create.briefing-why-text"
                  data-ack-id={s.id}
                  style={{
                    // The gap this replaces lives INSIDE the clipped box, so
                    // it collapses with the body instead of outliving it.
                    marginTop: "var(--space-2)",
                    fontSize: "var(--text-sm)",
                    lineHeight: 1.6,
                    color: "var(--fg-2)",
                  }}
                >
                  {s.why}
                </div>
              </WhyDisclosure>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  marginTop: "var(--space-2)",
                  cursor: "pointer",
                  fontSize: "var(--text-sm)",
                  lineHeight: 1.5,
                  color: acked[s.id] ? "var(--fg-1)" : "var(--fg-2)",
                }}
              >
                <Checkbox
                  checked={!!acked[s.id]}
                  onChange={(next) =>
                    setAcked((prev) => ({ ...prev, [s.id]: next }))
                  }
                  testId="create.briefing-ack"
                  data-ack-id={s.id}
                >
                  {s.ackLabel}
                </Checkbox>
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
          {t("common.back")}
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

/**
 * How long a collapsing body stays mounted after `open` flips false: one
 * `--duration-base` transition (180ms) plus the same 60ms slack
 * `TREE_ANIM_TOTAL_MS` (NoteList) takes, so the node is unmounted only once
 * the motion has fully settled. The issue that specifies this mechanism names a
 * local constant here, mirroring `TREE_ANIM_TOTAL_MS` rather than reading the
 * token back.
 */
const WHY_SETTLE_MS = 240;

/**
 * The animated "Why?" body (myne-md/myne#868).
 *
 * Both ends move. Opening mounts the body at the collapsed `0fr` state and
 * flips to `1fr` on the next frame; a collapse plays the same transition back
 * and only THEN drops the node, so a resting row leaves the DOM exactly as it
 * did before this change. That contract is pinned by this component's test and
 * by the `MYND-114` E2E scenario, neither of which moves with it. The mechanic
 * mirrors `DisclosureWrapper` in NoteList: `grid-template-rows` 1fr<->0fr plus
 * an opacity fade, both on `--duration-base`. The curve is per direction, as
 * there: `--ease-out` opens, `--ease-standard` closes. `height` is never
 * transitioned. The inner box carries `min-height: 0` + `overflow: hidden`, so
 * the collapsed track actually clips its content rather than leaving it painted.
 *
 * Reduced motion resolves both ends instantly, via the same optional-`?`
 * `matchMedia` check NoteList's folder toggle makes, and both arms are covered
 * by a test that stubs `matchMedia` (jsdom does not provide one, so the
 * animated path is what an unstubbed run measures).
 */
function WhyDisclosure({ open, children }: { open: boolean; children: ReactNode }) {
  // `mounted` = the node is in the DOM; `shown` = its animated (open) value.
  // Both start at `open` because this only ever mounts collapsed.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useLayoutEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    if (open) {
      // Already open, which is the mount run whose initial state matches.
      // Nothing to animate, and flipping would play an entrance nobody asked
      // for.
      if (shown) return;
      setMounted(true);
      if (reduce) {
        setShown(true);
        return;
      }
      // The body mounts at the collapsed value (`shown` is still false), then
      // flips on the next frame so the property change has a value to
      // transition FROM.
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }

    // A row that was never opened has nothing mounted to animate out.
    if (!mounted) return;
    setShown(false);
    if (reduce) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), WHY_SETTLE_MS);
    return () => clearTimeout(timer);
    // Deliberately `[open]` alone: this effect reacts to an `open` CHANGE, so
    // the `shown`/`mounted` reads above are the committed values at that
    // moment. Reacting to them as well would re-enter on this effect's own
    // updates and cancel the frame/timer it just scheduled.
  }, [open]);

  if (!mounted) return null;
  // Read in the SAME commit as the value that changes, so the browser sees the
  // matching curve alongside the `0fr`/`1fr` flip.
  const easing = shown ? "var(--ease-out)" : "var(--ease-standard)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: shown ? "1fr" : "0fr",
        // Bound the implicit column to the card: without it the column grows
        // to the paragraph's max-content and the long copy overflows the row.
        gridTemplateColumns: "minmax(0, 1fr)",
        minWidth: 0,
        opacity: shown ? 1 : 0,
        transition: `grid-template-rows var(--duration-base) ${easing}, opacity var(--duration-base) ${easing}`,
      }}
    >
      <div style={{ minHeight: 0, minWidth: 0, overflow: "hidden" }}>{children}</div>
    </div>
  );
}
