// The scope-expansion approval, phone-shaped (myne-md/myne#456 task 11).
//
// **The four facts are the same four the desktop dialog carries**, resolved
// through the same i18n keys (`agent.scope.*`) so neither client can reword the
// gate on its own. What is NOT shared is the layout, and that is the whole
// reason this is a second file rather than an alias: desktop's is a 34rem box
// with the actions right-aligned in a row, which on a 390px screen puts the
// decision under the reader's thumb in the wrong order and can push it off the
// bottom entirely.
//
// The four, in the desktop file's own words because they are its argument:
//
//   1. that the grant covers READING AND CHANGING those notes, in those words.
//      "Include this folder" describes a smaller permission than the one being
//      given, and the difference is the whole of what this screen is for.
//   2. the note COUNT, not only the container's name. "Projects" is not a size.
//   3. the run's NEW RUNNING TOTAL, because the hazard here is accumulation
//      across several individually-reasonable grants rather than any one of
//      them. Under the chosen design this screen IS the gate: there is no cap
//      on how far a run's scope may grow and no ceiling on how many times the
//      model may ask.
//   4. on a remote provider, that the notes LEAVE THE DEVICE.
//
// **Rendered even when the preview call failed**, which is the same call
// desktop's file records making and for the same reason: gating the screen on a
// successful fetch hid the decline button too, leaving a run waiting on an
// answer the user had no way to give. An approval asked without its numbers is
// a worse offer than one with them and a far better outcome than no offer.
//
// The model's stated reason is rendered as the model's CLAIM, not as fact. Note
// content can steer it, which is exactly the surface this screen guards.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../components/Button";

/** Which provider arm is serving, which decides whether the egress line shows.
 *
 *  **Two members, not desktop's three.** The desktop dialog's `ProviderArm`
 *  carries `"local"` because that client can answer from a model file or a
 *  loopback runtime. No model on a phone SERVES AN AGENT RUN (`mobile/src/lib/
 *  agent-run.ts`), so its only producer emits `"none"` or `"remote"` and a
 *  `"local"` branch here was unreachable code whose copy said "a program
 *  running on this COMPUTER": desktop wording that would have been wrong the
 *  day it fired. Narrowed rather than defended: the day mobile gains a local
 *  arm, this type is where that decision surfaces.
 *
 *  **Scoped to agent runs on purpose, and the loose form of this sentence is a
 *  privacy overclaim.** "Myne runs no model on a phone" is false: a quantized
 *  whisper-tiny GGUF ships in the mobile bundle and runs IN PROCESS for
 *  transcription, and OCR weights ship there too. So the in-process,
 *  not-sandboxed residual `docs/threat-model.md` states for a bundled
 *  first-party model applies on this client as much as on the desktop, and a
 *  sentence that removes it for a whole platform is the direction the
 *  marketing-copy rule exists to prevent. */
export type ProviderArm = "none" | "remote";

const FACT: CSSProperties = {
  margin: "var(--space-3) 0 0",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-1)",
};

const FACT_MUTED: CSSProperties = { ...FACT, color: "var(--fg-2)" };

export function AiScopeSheet({
  folder,
  noteCount,
  excludedCount,
  newTotal,
  reason,
  arm,
  providerName,
  onApprove,
  onDecline,
}: {
  /** The folder the model asked for. */
  folder: string;
  /** How many notes that folder holds, already clamped. `null` when the preview
   *  call FAILED. Nullable rather than defaulted to zero, because the two mean
   *  opposite things to someone deciding: zero says "this grant adds nothing",
   *  null says "we could not find out". */
  noteCount: number | null;
  /** How many of its notes the AI-excluded-folders control removed. */
  excludedCount: number | null;
  /** The run's scope total if this grant is approved. */
  newTotal: number | null;
  /** The model's stated reason. Untrusted: rendered as its claim. */
  reason: string;
  arm: ProviderArm;
  providerName?: string;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const { t } = useTranslation();
  const unknown = noteCount === null || newTotal === null || excludedCount === null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-scope-title"
      data-testid="agentScope.dialog"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: "var(--z-modal)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        background: "var(--scrim, rgba(0,0,0,0.45))",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          maxHeight: "88%",
          background: "var(--bg-1)",
          borderTopLeftRadius: "var(--radius-3)",
          borderTopRightRadius: "var(--radius-3)",
          borderTop: "1px solid var(--line-1)",
        }}
      >
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "var(--space-4)" }}>
          <h2
            id="agent-scope-title"
            data-testid="agentScope.title"
            style={{
              margin: 0,
              fontSize: "var(--text-lg)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--fg-1)",
            }}
          >
            {t("agent.scope.title", { folder })}
          </h2>

          {unknown ? (
            <p data-testid="agentScope.countsUnavailable" style={FACT}>
              {t("agent.scope.countsUnavailable", { folder })}
            </p>
          ) : (
            <>
              {/* Fact 1 and fact 2 together: read AND change, and how many. */}
              <p data-testid="agentScope.grant" style={FACT}>
                {t("agent.scope.grant", { folder, count: noteCount })}
              </p>
              {/* Fact 3: the running total the accumulation hazard needs. */}
              <p data-testid="agentScope.total" style={FACT_MUTED}>
                {t("agent.scope.newTotal", { count: newTotal })}
              </p>
              {/* What the content control removed, stated rather than silently
                  dropped. Shown even at zero, so an absent line never has to be
                  read as "no exclusions" versus "we did not check". */}
              <p data-testid="agentScope.excluded" style={FACT_MUTED}>
                {t("agent.scope.excluded", { count: excludedCount })}
              </p>
            </>
          )}

          {/* Fact 4, remote arm only. */}
          {arm === "remote" && (
            <p data-testid="agentScope.egress" style={FACT}>
              {t("agent.scope.egressRemote", { provider: providerName ?? "" })}
            </p>
          )}

          <blockquote
            data-testid="agentScope.reason"
            style={{
              margin: "var(--space-4) 0 0",
              padding: "var(--space-3)",
              borderInlineStart: "2px solid var(--line-1)",
              color: "var(--fg-2)",
              fontSize: "var(--text-sm)",
              lineHeight: "var(--leading-normal)",
            }}
          >
            {t("agent.scope.reasonLabel")} {reason}
          </blockquote>
        </div>

        {/* Stacked rather than a row, and Decline on the BOTTOM. Neither is an
            accident on a phone. A row of two full-width-ish buttons on a 390px
            screen puts them a thumb-slip apart; stacking makes each a separate
            act. And the bottom edge is the easiest place for a thumb to land,
            so the button that sits there is the one that widens NOTHING. The
            approval is the deliberate reach. */}
        <div
          style={{
            flex: "none",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
            padding:
              "var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom, 0px))",
            borderTop: "1px solid var(--line-1)",
          }}
        >
          <Button data-testid="agentScope.approve" onClick={onApprove}>
            {t("agent.scope.approve")}
          </Button>
          <Button variant="secondary" data-testid="agentScope.decline" onClick={onDecline}>
            {t("agent.scope.decline")}
          </Button>
        </div>
      </div>
    </div>
  );
}
