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
import {
  aiCapabilityReport,
  answeredByOf,
  providerLabelOf,
} from "../../../lib/ai-capability";
import { usePrefs } from "../../../hooks/usePrefs";
import { failRun, resumeRun, settleStep, useAgent } from "../agentStore";
import { ScopeExpansionDialog, type ProviderArm } from "./ScopeExpansionDialog";

export function AgentProgress() {
  const { t } = useTranslation();
  const agent = useAgent();
  const { prefs } = usePrefs();
  const [preview, setPreview] = useState<GrantPreview | null>(null);
  const [arm, setArm] = useState<{ arm: ProviderArm; providerName?: string }>({
    arm: "none",
  });
  const awaiting = agent.end?.kind === "awaitingScope" ? agent.end : null;
  const runId = agent.view?.runId ?? null;
  const folder = awaiting?.folder ?? null;

  // **Whether approving sends more text off the device, resolved HERE.**
  //
  // This used to be an `arm` prop with a `"none"` default and a doc comment
  // saying the component could not ask the host without inventing a second
  // source for a fact the AI settings surface already resolves. The premise was
  // wrong in both halves: `ai-capability.ts` IS that one source, so calling it
  // is reading the fact rather than duplicating it -- and the prop's only call
  // site, `AiChatTab`, passed nothing. So the default held on every render, and
  // the fourth fact of the expansion gate, the one that says notes are about to
  // leave the machine, rendered on neither arm. `ag5` asserts it is present.
  //
  // `AGENT_REQUEST_CLASS` is `UserInitiated`, so the agent is served by the
  // ACTIVE arm and the report describes it. An ambient request would be barred
  // onto the local arm and this would be the wrong question to ask; the loop's
  // constant is what makes it the right one.
  const providerLabel = providerLabelOf(prefs.ai_provider) ?? undefined;
  useEffect(() => {
    if (folder === null) {
      setArm({ arm: "none" });
      return;
    }
    let live = true;
    void aiCapabilityReport().then((report) => {
      if (!live) return;
      // A build with no AI in it leaves `none`, so the dialog states no egress
      // claim rather than guessing one. Checked BEFORE the mapping, because
      // `answeredByOf` reads an unknown class as `in-process`, and answering
      // "these notes stay on the device" from a report that answered nothing
      // would be a reassurance nobody measured.
      if (!report.compiled) {
        setArm({ arm: "none" });
        return;
      }
      const by = answeredByOf(report, providerLabel);
      // `in-process` is the bundled engine and `local-runtime` a program on this
      // machine; both stay on the device, so both are the local arm.
      setArm(
        by.kind === "remote"
          ? { arm: "remote", providerName: by.provider }
          : { arm: "local" },
      );
    });
    return () => {
      live = false;
    };
  }, [folder, providerLabel]);

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
          arm={arm.arm}
          providerName={arm.providerName}
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
