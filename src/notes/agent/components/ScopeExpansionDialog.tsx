// The scope-expansion approval (myne-md/myne#529, task 9).
//
// Under the chosen design this screen IS the gate. There is no cap on how far a
// run's scope may grow and no ceiling on how many times the model may ask, so
// what bounds accumulation is that every widening is approved here and the
// running total is visible while the user decides.
//
// Four facts are required and none of them is decoration:
//
//   1. that the grant covers READING AND CHANGING those notes, in those words.
//      "Include this folder" describes a smaller permission than the one being
//      given, and the difference is the whole of what this dialog is for.
//   2. the note COUNT, not only the container's name. "Projects" is not a size.
//   3. the run's NEW RUNNING TOTAL, because the hazard here is accumulation
//      across several individually-reasonable grants rather than any one of
//      them.
//   4. on a remote provider, that the notes LEAVE THE DEVICE. That line reuses
//      the copy shape fixed in `design-notes/ai/0461` rather than new wording,
//      because the invariant sentence there is pinned by tests elsewhere and a
//      second phrasing of the same promise is how the two drift.
//
// The model's stated reason is rendered as the model's claim, not as fact: note
// content can steer it, which is exactly the surface this dialog guards.

import { useTranslation } from "react-i18next";

import { Button } from "../../../components/primitives/Button";

/** Which provider arm is serving, which decides whether the egress line shows.
 *  Mirrors the backend's backend-class vocabulary rather than inventing one. */
export type ProviderArm = "none" | "local" | "remote";

export interface ScopeExpansionDialogProps {
  /** The folder the model asked for. */
  folder: string;
  /** How many notes that folder holds, already clamped. `null` when the
   *  preview call FAILED.
   *
   *  Nullable rather than defaulted to zero, because the two mean opposite
   *  things to someone deciding: zero says "this grant adds nothing", and null
   *  says "we could not find out". The dialog renders the difference. */
  noteCount: number | null;
  /** How many of its notes the AI-excluded-folders control removed. `null` when
   *  the preview failed; see {@link noteCount}. */
  excludedCount: number | null;
  /** The run's scope total if this grant is approved. `null` when the preview
   *  failed; see {@link noteCount}. */
  newTotal: number | null;
  /** The model's stated reason. Untrusted: rendered as its claim. */
  reason: string;
  /** Which arm is serving. Decides the egress line. */
  arm: ProviderArm;
  /** The provider's display name, for the remote line. */
  providerName?: string;
  onApprove: () => void;
  onDecline: () => void;
}

export function ScopeExpansionDialog({
  folder,
  noteCount,
  excludedCount,
  newTotal,
  reason,
  arm,
  providerName,
  onApprove,
  onDecline,
}: ScopeExpansionDialogProps) {
  const { t } = useTranslation();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-scope-title"
      data-testid="agentScope.dialog"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4)",
        padding: "var(--space-5)",
        background: "var(--bg-1)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-3)",
        maxWidth: "34rem",
      }}
    >
      <h2
        id="agent-scope-title"
        data-testid="agentScope.title"
        style={{
          margin: 0,
          fontSize: "var(--text-xl)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--fg-1)",
        }}
      >
        {t("agent.scope.title", { folder })}
      </h2>

      {/* Fact 1: read AND change, in those words. */}
      {/* The counts, or the fact that they could not be fetched. The dialog is
          rendered EITHER way: it used to be gated on a successful preview, so a
          failed one hid the whole thing and took the decline button with it,
          leaving a run waiting on an answer the user had no way to give. An
          approval asked without its numbers is a worse offer than one with them,
          and it is a far better outcome than no offer at all. */}
      {noteCount === null || newTotal === null || excludedCount === null ? (
        <p
          data-testid="agentScope.countsUnavailable"
          style={{ margin: 0, color: "var(--fg-1)" }}
        >
          {t("agent.scope.countsUnavailable", { folder })}
        </p>
      ) : (
        <>
          <p
            data-testid="agentScope.grant"
            style={{ margin: 0, color: "var(--fg-1)" }}
          >
            {t("agent.scope.grant", { folder, count: noteCount })}
          </p>

          {/* Fact 3: the running total the accumulation hazard needs. */}
          <p
            data-testid="agentScope.total"
            style={{ margin: 0, color: "var(--fg-2)" }}
          >
            {t("agent.scope.newTotal", { count: newTotal })}
          </p>

          {/* Fact 2's other half: what the content control removed, stated
              rather than silently dropped. Shown even at zero, so an absent line
              never has to be read as "no exclusions" versus "we did not
              check". */}
          <p
            data-testid="agentScope.excluded"
            style={{ margin: 0, color: "var(--fg-2)" }}
          >
            {t("agent.scope.excluded", { count: excludedCount })}
          </p>
        </>
      )}

      {/* Fact 4, remote arm only. */}
      {arm === "remote" ? (
        <p
          data-testid="agentScope.egress"
          style={{ margin: 0, color: "var(--fg-1)" }}
        >
          {t("agent.scope.egressRemote", { provider: providerName ?? "" })}
        </p>
      ) : null}
      {arm === "local" ? (
        <p
          data-testid="agentScope.egress"
          style={{ margin: 0, color: "var(--fg-2)" }}
        >
          {t("agent.scope.egressLocal")}
        </p>
      ) : null}

      <blockquote
        data-testid="agentScope.reason"
        style={{
          margin: 0,
          padding: "var(--space-3)",
          borderLeft: "2px solid var(--line-1)",
          color: "var(--fg-2)",
          fontSize: "var(--text-sm)",
        }}
      >
        {t("agent.scope.reasonLabel")} {reason}
      </blockquote>

      <div style={{ display: "flex", gap: "var(--space-3)", justifyContent: "flex-end" }}>
        <Button variant="ghost" onClick={onDecline} data-testid="agentScope.decline">
          {t("agent.scope.decline")}
        </Button>
        <Button variant="primary" onClick={onApprove} data-testid="agentScope.approve">
          {t("agent.scope.approve")}
        </Button>
      </div>
    </div>
  );
}
