// What a run looks like while it works (myne-md/myne#529, task 8).
//
// Two jobs, and the second is the load-bearing one.
//
//   1. A long run must not read as a hang. An agent over a large scope takes
//      minutes, and a surface that says nothing during it is a surface the user
//      force-quits.
//   2. **The running scope total is shown continuously.** With no cap on how far
//      a scope may grow and no ceiling on how many times the model may ask, this
//      number is the entire bound on accumulation. It is not a status detail and
//      it does not belong behind a disclosure.
//
// The cancel control sets the same flag the vault-lock teardown sets: one
// mechanism, two callers.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../../components/primitives/Button";
import {
  agentApproveScope,
  agentCancel,
  agentPreviewGrant,
  type GrantPreview,
} from "../../../lib/agent-run";
import { failRun, resumeRun, settleStep, useAgent } from "../agentStore";
import { ScopeExpansionDialog, type ProviderArm } from "./ScopeExpansionDialog";

export function AgentProgress({
  arm = "none",
  providerName,
}: {
  /** Which provider arm is serving. Decides the expansion dialog's egress line;
   *  the dialog cannot ask the host itself without inventing a second source for
   *  a fact the AI settings surface already resolves. */
  arm?: ProviderArm;
  providerName?: string;
} = {}) {
  const { t } = useTranslation();
  const agent = useAgent();
  const [preview, setPreview] = useState<GrantPreview | null>(null);
  const awaiting = agent.end?.kind === "awaitingScope" ? agent.end : null;
  const runId = agent.view?.runId ?? null;
  const folder = awaiting?.folder ?? null;

  // The dialog's numbers come from the host, resolved by the same code the
  // commit runs. Computing them here would leave out the excluded-folder clamp
  // and would add rather than union, so the gate would state a size the host
  // will not honour.
  useEffect(() => {
    if (folder === null || runId === null) {
      setPreview(null);
      return;
    }
    let live = true;
    void agentPreviewGrant({ kind: "folder", value: folder }, runId)
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch(() => {
        if (live) setPreview(null);
      });
    return () => {
      live = false;
    };
  }, [folder, runId]);
  // The error is rendered even with no run. `beginRun()` clears `view`, so a
  // failed start left `error` set and `view` null, and an early return here made
  // the message unreachable: pressing Send on a failing backend produced no
  // message, no spinner and no state change.
  if (!agent.view) {
    return agent.error ? (
      <div
        data-testid="agentProgress.root"
        style={{
          padding: "var(--space-2) var(--space-3)",
          background: "var(--bg-1)",
          borderBottom: "1px solid var(--line-1)",
          color: "var(--danger)",
        }}
      >
        <span data-testid="agentProgress.error">{agent.error}</span>
      </div>
    ) : null;
  }

  const { view, running, end } = agent;
  const status = running
    ? t("agent.progress.working")
    : end?.kind === "awaitingScope"
      ? t("agent.progress.awaitingScope")
      : end?.kind === "cancelled"
        ? t("agent.progress.cancelled")
        : end?.kind === "exhaustedIterations"
          ? t("agent.progress.exhausted")
          : t("agent.progress.done");

  return (
    <>
      {awaiting !== null && runId !== null && preview !== null ? (
        <ScopeExpansionDialog
          folder={awaiting.folder}
          noteCount={preview.noteCount}
          excludedCount={preview.excludedCount}
          newTotal={preview.newTotal}
          reason={awaiting.reason}
          arm={arm}
          providerName={providerName}
          onApprove={() => {
            resumeRun();
            void agentApproveScope(runId, {
              kind: "folder",
              value: awaiting.folder,
            })
              .then(settleStep)
              .catch(() => failRun(t("agent.progress.expandFailed")));
          }}
          onDecline={() => void agentCancel(runId)}
        />
      ) : null}
    <div
      data-testid="agentProgress.root"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "var(--space-2) var(--space-3)",
        background: "var(--bg-1)",
        borderBottom: "1px solid var(--line-1)",
        color: "var(--fg-2)",
      }}
    >
      <span data-testid="agentProgress.status">{status}</span>

      {/* Continuously visible, by design. See the module note. */}
      <span data-testid="agentProgress.scopeTotal">
        {t("agent.progress.scopeTotal", { count: view.scopeTotal })}
      </span>

      {/* How the scope got that big, split by who asked. A run whose model-grant
          count is climbing is the shape the no-cap decision leaves visible. */}
      <span data-testid="agentProgress.grants">
        {t("agent.progress.grantsUser", { count: view.userGrants })}
        {", "}
        {t("agent.progress.grantsModel", { count: view.modelGrants })}
      </span>

      <span style={{ flex: 1 }} />

      {running ? (
        <Button
          variant="ghost"
          onClick={() => void agentCancel(view.runId)}
          data-testid="agentProgress.cancel"
        >
          {t("agent.progress.cancel")}
        </Button>
      ) : null}

      {agent.error ? (
        <span data-testid="agentProgress.error" style={{ color: "var(--danger)" }}>
          {agent.error}
        </span>
      ) : null}
    </div>
    </>
  );
}
