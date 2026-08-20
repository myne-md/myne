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
  type LoopEnd,
} from "../../../lib/agent-run";
import {
  aiCapabilityReport,
  answeredByOf,
  providerLabelOf,
} from "../../../lib/ai-capability";
import { usePrefs } from "../../../hooks/usePrefs";
import { currentRunEpoch, failRun, resumeRun, useAgent } from "../agentStore";
import { settleRunIntoChat } from "../../ai/agentToChat";
import { ScopeExpansionDialog, type ProviderArm } from "./ScopeExpansionDialog";

/** How a stopped run is described, given the tag its loop ended on.
 *
 *  Exported because the transcript turn says the same thing about a run whose
 *  proposal has since been dropped, and a second partial copy of this mapping
 *  had already gone out of step: it covered two of the four tags and rendered
 *  nothing for the rest, so a fifth `LoopEnd` variant would have been picked up
 *  by one site and silently not the other.
 *
 *  A total switch with static `t("…")` calls rather than a lookup table, for
 *  the reason `AiChatTab`'s own resting-cause switch states: `check-i18n.mjs`
 *  verifies static call sites, so a key living in a `Record` is a key no guard
 *  checks. Written this way the compiler catches a missing tag and the guard
 *  catches a missing translation. */
export function endStatusLabel(
  kind: LoopEnd["kind"] | undefined,
  t: (key: string) => string,
): string {
  switch (kind) {
    case "awaitingScope":
      return t("agent.progress.awaitingScope");
    case "cancelled":
      return t("agent.progress.cancelled");
    case "exhaustedIterations":
      return t("agent.progress.exhausted");
    case "finished":
    case undefined:
      return t("agent.progress.done");
  }
}

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
  // This strip describes a RUN, so with no view there is nothing to describe.
  // It used to render `agent.error` here too, for the failed-start case where
  // `beginRun()` has nulled the view. That case now renders on the run's own
  // transcript turn (`AiChatTab`), which is where the user is looking and which
  // keeps the message after the next run replaces this store's copy.
  if (!agent.view) return null;

  const { view, running, end } = agent;
  const status = running ? t("agent.progress.working") : endStatusLabel(end?.kind, t);

  return (
    <>
      {/* NOT gated on `preview`. The preview is a nicety; the dialog is the only
          way to answer a run that is waiting, and gating on a successful fetch
          meant a failed one hid the decline button too. */}
      {awaiting !== null && runId !== null ? (
        <ScopeExpansionDialog
          folder={awaiting.folder}
          noteCount={preview?.noteCount ?? null}
          excludedCount={preview?.excludedCount ?? null}
          newTotal={preview?.newTotal ?? null}
          reason={awaiting.reason}
          arm={arm.arm}
          providerName={arm.providerName}
          onApprove={() => {
            resumeRun();
            // Captured before the await, so a vault lock during the approval
            // invalidates the reply rather than being raced by it.
            const epoch = currentRunEpoch();
            void agentApproveScope(runId, {
              kind: "folder",
              value: awaiting.folder,
            })
              // The transcript half comes with the settle rather than after it:
              // this is the SECOND place a step settles, and a mirror written
              // only at the start site would leave an approved expansion's
              // numbers stale on the turn that shows them.
              .then((result) => settleRunIntoChat(result, epoch))
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
