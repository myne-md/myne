// The scope-expansion dialog, and its provider arm (myne-md/myne#529, task 8).
//
// ── This used to be a strip, and the strip is gone (myne-md/myne#848) ───────
// It rendered the run's status, its running scope total, the grant breakdown and
// the cost line in a band pinned under the transcript, outside the scrolling
// region. Three things were wrong with that, and the third is why it moved:
//
//   1. the transcript's own record of a run had no figures in it, so scrolling
//      back through a conversation showed turns that described runs without
//      saying what they cost;
//   2. the band and the settled turn said the same thing twice;
//   3. "New chat" deletes the transcript and NOT the run, so the band outlived
//      the turn it described.
//
// The figures live on the run's own transcript entry now
// (`AgentFootprint.tsx`), which is where "the running scope total is shown
// continuously" still holds, the entry is on the turn from the first frame of
// the run and ticks while it works.
//
// ── What is left here, and why it is still OUT of the scroller ──────────────
// The scope-expansion dialog. It is the entire bound `design-notes/ai/0515`
// puts on model-originated scope growth, and mounting it inside the scrolling
// region put it below whatever the reader had scrolled to. A dialog is not a
// strip: it is modal, it steals focus, and its lifetime is the QUESTION rather
// than the turn, which is why it stays tied to the run.
//
// The cancel control sets the same flag the vault-lock teardown sets: one
// mechanism, two callers.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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
import { providerErrorKey } from "../../../lib/engine-error";
import {
  currentRunEpoch,
  failRun,
  reportRunProgress,
  resumeRun,
  useAgent,
} from "../agentStore";
import { legFailureSentence, settleRunIntoChat } from "../../ai/agentToChat";
import { ScopeExpansionDialog, type ProviderArm } from "./ScopeExpansionDialog";

/** How a stopped run is described, given the tag its loop ended on.
 *
 *  Exported because the transcript turn says the same thing about a run whose
 *  proposal has since been dropped, and a second partial copy of this mapping
 *  had already gone out of step: it covered two of the four tags and rendered
 *  nothing for the rest, so a fifth `LoopEnd` variant would have been picked up
 *  by one site and silently not the other.
 *
 *  A total switch with static quoted-key calls rather than a lookup table, for
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
    case "stalled":
      return t("agent.progress.stalled");
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
            void agentApproveScope(
              runId,
              {
                kind: "folder",
                value: awaiting.folder,
              },
              // The approved leg reports its cost too (myne-md/myne#456), or
              // the figures would freeze the moment a run widened its scope:
              // which is precisely when a user most wants to see them moving,
              // because widening is what makes a run expensive.
              (progress) => {
                reportRunProgress(progress, epoch);
              },
            )
              // The transcript half comes with the settle rather than after it:
              // this is the SECOND place a step settles, and a mirror written
              // only at the start site would leave an approved expansion's
              // numbers stale on the turn that shows them.
              .then((result) => settleRunIntoChat(result, epoch))
              // Epoch-checked for the reason `agentToChat.ts`'s catch states:
              // the success path is guarded transitively by `settleStep`, and a
              // failure that lands after the run was let go of would otherwise
              // clear a NEWER run's `running` and record its message.
              .catch((failure: unknown) => {
                if (epoch !== currentRunEpoch()) return;
                // **The leg's OWN failure, not a scope refusal**
                // (myne-md/myne#848, on the user's report). This reported every
                // failure of the approved leg as "The scope could not be
                // widened", so a user who had just pressed Allow was told their
                // permission had not been taken, while `modelGrants` on the
                // very same turn showed it had, and the real cause (a provider
                // that refused the request, a timeout, an engine failure) was
                // thrown away. `RootGrant` is the one tag the scope sentence is
                // about, and the host's tag decides; see
                // `legFailureSentence`.
                failRun(
                  legFailureSentence(failure, {
                    providerRejected: t("agent.composer.providerRejected"),
                    modelCannotEdit: t("agent.composer.modelCannotEdit"),
                    stillWorking: t("agent.composer.stillWorking"),
                    scopeExcluded: t(providerErrorKey("empty_grant")),
                    rootGrant: t("agent.progress.expandFailed"),
                    generic: t("agent.progress.legFailed"),
                    byCause: (cause) => t(providerErrorKey(cause)),
                  }),
                );
              });
          }}
          onDecline={() => void agentCancel(runId)}
        />
      ) : null}
    </>
  );
}
