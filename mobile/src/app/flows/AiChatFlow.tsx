// The mobile AI destination (myne-md/myne#457, myne-md/myne#456).
//
// **One composer and one mode.** There is no Ask/Edit control, because there is
// no Ask: `docs/decisions/ai/0524` collapsed the two into one, so every message
// starts an agent run and a question is answered by the run's finish summary.
// A mode switch here would be offering a choice the host does not have.
//
// **The run state is NOT this component's.** It lives in `@myne/agent-store`,
// which is module-scope and shared verbatim with desktop: the epoch guards, the
// leg-base accumulation and the rejection sets are rules, and a second copy of
// a rule is a second version of it. That the store outlives every unmount is
// what makes the lock teardown necessary rather than optional, a proposal
// holds anchors and replacements copied out of note bodies, so leaving this
// screen must not be what clears it and locking the vault must
// (`clearAgentForLock`, wired in task 14).
//
// **What this file owns is the surface**: the text field, the Send and Stop
// controls, and the reading of the store. Every refusal, every scope
// arithmetic and the excluded-folder clamp are host-side and none of them is
// computed here, the rule `docs/decisions/ai/0462` states, inherited through
// the shared bindings.
//
// The scope is the vault by folder-less default at this stage: task 11 adds the
// approval and expansion surface, and task 12 the review screen. Until those
// land a finished run's proposal is reported and not applied, which is the
// honest intermediate state rather than a silent write.

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { providerLabelOf } from "@myne/copy";
import { normalizeProviderError, providerErrorKey } from "@myne/engine-error";
import type { ProviderErrorCause } from "@myne/engine-error";
import { RunCostLine } from "@myne/run-cost-line";
import {
  beginRun,
  currentRunEpoch,
  failRun,
  openRun,
  clearAgent,
  reportRunProgress,
  resumeRun,
  settleStep,
  useAgent,
  getAgent,
  setProbeVerdict,
} from "@myne/agent-store";
import { scopeKey } from "@myne/agent-protocol";
import type { GrantPreview, ProbeVerdict, ScopeGrant } from "@myne/agent-protocol";

import {
  agentApproveScope,
  agentCancel,
  agentCapability,
  agentPreviewGrant,
  agentStart,
} from "../../lib/agent-run";
import { usePrefs } from "../../lib/use-prefs";
import { Button } from "../../components/Button";
import { ScreenScroll } from "../../components/layout";
import { AiReviewFlow } from "./AiReviewFlow";
import { AiUndoStrip } from "./AiUndoStrip";
import { AiScopeSheet, type ProviderArm } from "./AiScopeSheet";

const COMPOSER_BAR: CSSProperties = {
  flex: "none",
  display: "flex",
  gap: "var(--space-2)",
  alignItems: "flex-end",
  padding: "var(--space-2) var(--space-3) calc(var(--space-2) + env(safe-area-inset-bottom, 0px))",
  borderTop: "1px solid var(--line-1)",
  background: "var(--bg-1)",
};

const INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  resize: "none",
  minHeight: 40,
  maxHeight: 140,
  padding: "var(--space-2)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1)",
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
};

const BODY_TEXT: CSSProperties = {
  margin: "var(--space-2) 0 0",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-1)",
};

const MUTED: CSSProperties = {
  ...BODY_TEXT,
  color: "var(--fg-3)",
};

const SCOPE_STRIP: CSSProperties = {
  flex: "none",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-2) var(--space-3)",
  borderTop: "1px solid var(--line-1)",
  background: "var(--bg-2)",
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
};

const COST: CSSProperties = {
  display: "block",
  marginTop: "var(--space-1)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

export function AiChatFlow({
  /** The scope every message runs under: the open note, or `null` when there
   *  is none. NOT a vault-wide fallback, because the host REFUSES one. See
   *  `defaultGrantFor` in `@myne/agent-protocol` for why. */
  grant,
  titleOf,
  bodyOf,
  onNotesWritten,
  onOpenHistory,
}: {
  grant: ScopeGrant | null;
  /** Resolve a note's title, for the review list. The proposal carries ids. */
  titleOf: (noteId: string) => string | null;
  /** Read a note's current body, for the review's diff. */
  bodyOf: (noteId: string) => string | null;
  onNotesWritten?: (noteIds: string[]) => void;
  /** Open the per-note version history for a note the last run wrote. The
   *  durable path the undo strip's copy names, so the sentence points at
   *  something reachable rather than at a concept. */
  onOpenHistory?: (noteId: string) => void;
}) {
  const { t } = useTranslation();
  const agent = useAgent();
  const [draft, setDraft] = useState("");
  // The task the run in flight was started with, so the surface can show what
  // was asked while the answer is still coming. Not in the store: the store is
  // the RUN's state and this is the composer's memory of its own send.
  const [asked, setAsked] = useState<string | null>(null);
  const { prefs } = usePrefs();
  // What the scope the user is about to send actually covers, resolved by the
  // host. `null` when the call has not landed or failed.
  const [preview, setPreview] = useState<GrantPreview | null>(null);
  // The scope the model has asked to widen into, previewed the same way.
  const [expansion, setExpansion] = useState<GrantPreview | null>(null);
  // In flight only. The VERDICT is session state and lives in the run store, so
  // a remount does not pay for it twice and the lock teardown drops it.
  const [probing, setProbing] = useState(false);

  // **The arm is read from the prefs, not probed.** A probe is a third-party
  // request (TB13), and this line renders before the user has asked for
  // anything, so probing here would make opening a tab an act of egress.
  const provider = prefs.ai_provider;
  const arm: ProviderArm =
    provider === null || provider === "" ? "none" : "remote";
  const providerName = provider === null ? undefined : (providerLabelOf(provider) ?? provider);

  // **The disclosure BEFORE the first tool call.** The host resolves the grant
  // with the same code the run will use, so the number on screen is the number
  // the run will honour: computing it here would leave out the excluded-folder
  // clamp and would add rather than union, and the user would be approving
  // against a figure wrong in two directions.
  //
  // A preview, never a reservation: the set is resolved again when the run
  // starts, and the frozen set is that one.
  useEffect(() => {
    let live = true;
    setPreview(null);
    // Nothing to preview, and nothing to ask the host about. Skipping is not an
    // optimisation: the host REFUSES a root grant, so the call would spend a
    // round-trip to be told what this branch already knows.
    if (grant === null) return;
    void agentPreviewGrant(grant)
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch(() => {
        // Left null. The strip renders "could not be checked" rather than a
        // zero, because a zero is a claim and this is the absence of one.
        if (live) setPreview(null);
      });
    return () => {
      live = false;
    };
    // **Keyed on a STABLE string, not on the grant's fields.** `grant.value` is
    // a fresh array for the `notes` case, so every parent render re-fired this
    // effect: another `agent_preview_grant` round-trip, and the scope figure
    // blanking to "could not be checked" in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey(grant)]);

  // The expansion's numbers, fetched against the RUN so the total is the run's
  // new total rather than the folder's own size.
  const awaiting = agent.end?.kind === "awaitingScope" ? agent.end : null;
  const runId = agent.view?.runId ?? null;
  useEffect(() => {
    if (awaiting === null || runId === null) {
      setExpansion(null);
      return;
    }
    let live = true;
    void agentPreviewGrant({ kind: "folder", value: awaiting.folder }, runId)
      .then((p) => {
        if (live) setExpansion(p);
      })
      .catch(() => {
        if (live) setExpansion(null);
      });
    return () => {
      live = false;
    };
  }, [awaiting?.folder, runId]);

  /** The refusals that mean "this device is not configured to send", as opposed
 *  to "this model cannot hold the edit format".
 *
 *  Exactly the arms of `authorize_remote` plus the missing-model one, which is
 *  the same class from the user's side: something to change in settings, on a
 *  screen that exists, rather than a property of the backend. Anything else the
 *  probe can fail with is a transport or provider fault and belongs to the
 *  `failed` verdict. */
const GATE_REFUSALS: ReadonlySet<ProviderErrorCause> = new Set([
  "feature_off",
  "consent_missing",
  "no_credential",
  "not_ready",
  "barred",
]);

/** Whether the configured backend can hold the anchored edit format.
   *
   * **Fails CLOSED, and asks at most once per session.** The desktop twin's
   * module note carries the full argument for why the verdict lives in the run
   * store rather than in component state; the reason this client needs the gate
   * at all is narrower and was a real defect: without it agent mode was offered
   * on every backend, which is exactly the myne-md/myne#529 shape
   * `core/src/plugins/agent/edit.rs` and `probe.rs` BOTH name as the reason the
   * anchored format may refuse a near-miss rather than fuzzy-match it. Two
   * module docs were false on this client and every check was green.
   *
   * **On SEND, never on render.** A probe is a third-party request (TB13), so
   * firing it when the tab opens would make opening a tab an act of egress. The
   * user asking for a run is the consent this call rides on.
   *
   * Read through the store rather than this render's snapshot: a remount, or
   * the tab being reopened, may have paid for the answer already, and on a
   * remote provider re-probing costs `threshold.attempts` requests. */
  const ensureCapability = useCallback(async (): Promise<ProbeVerdict | null> => {
    const known = getAgent().probeVerdict;
    if (typeof known === "object" && known !== null) return known;
    setProbing(true);
    try {
      const v = await agentCapability();
      setProbeVerdict(v);
      return v;
    } catch (e) {
      // **A GATE refusal is not a failed probe, and collapsing the two is the
      // defect this arm exists to stop.** The probe reaches the provider, so it
      // passes through `authorize_remote` first: on a device that inherited the
      // provider and the key but has not consented LOCALLY, the probe is the
      // thing that gets refused, and reporting that as "we could not check your
      // model" names no fix while the fix is one tap away. It also undoes the
      // separation the error taxonomy was built for, where a missing key and a
      // missing consent are deliberately never merged.
      //
      // So a refusal the taxonomy recognizes is surfaced with ITS OWN message
      // and leaves the verdict UNASKED, which is what lets the user fix the
      // configuration and send again. Only an unclassifiable failure sets
      // `failed`, and that one fails closed: an unanswerable probe is not
      // evidence that the backend CAN hold the format.
      const cause = normalizeProviderError(e);
      if (GATE_REFUSALS.has(cause)) {
        failRun(t(providerErrorKey(cause)));
        return null;
      }
      setProbeVerdict("failed");
      return null;
    } finally {
      setProbing(false);
    }
  }, [t]);

  const send = useCallback(async () => {
    const task = draft.trim();
    if (task.length === 0 || agent.running || grant === null) return;
    const verdict = await ensureCapability();
    // **The draft is cleared AFTER the gate, not before.** The refusal is
    // rendered by the notice below, and a user who switches provider and sends
    // again must not have to retype what they wrote.
    if (verdict === null || !verdict.passed) return;
    setDraft("");
    setAsked(task);
    beginRun();
    // Captured BEFORE the await, which is the whole contract of the epoch: a
    // reply that lands after the user locked the vault, switched vault or
    // started another run must be dropped rather than repopulate the store.
    const epoch = currentRunEpoch();
    try {
      const result = await agentStart(
        task,
        grant,
        // The run becomes addressable here, long before the promise resolves.
        // Without it Stop has no id for the whole first leg.
        (view) => void openRun(view, epoch),
        // The live half of the cost disclosure. `agentStart` returns only when
        // the loop has STOPPED, so its reply is disclosure after the fact, and
        // a run cancelled: or killed with the foreground, which on a phone is
        // the ordinary case rather than the exotic one: would otherwise
        // disclose nothing at all while having paid for every round-trip.
        (progress) => void reportRunProgress(progress, epoch),
      );
      settleStep(result, epoch);
    } catch (e) {
      // **The cause, named, rather than one sentence for everything.** The gate
      // refuses in four distinct ways and the network fails in several more,
      // and each has a different fix in a different place. Collapsed, the user
      // reads "that did not work" and has nowhere to go.
      //
      // Two of the four are deliberately never merged: `no_credential` means
      // there is nothing to send, `consent_missing` means you have not agreed
      // to send it. They were ONE Rust variant until this issue, which is how a
      // user who had never seen the consent screen was told "this kind of
      // request never goes to a provider".
      //
      // Nothing about the task is in the message. The task is the user's own
      // words, and the taxonomy is content-free by construction: a variant tag,
      // never a prompt, a note body or a provider's response.
      failRun(t(providerErrorKey(normalizeProviderError(e))));
    }
  }, [draft, agent.running, grant, t, ensureCapability]);

  const stop = useCallback(() => {
    // The id may genuinely be null: the window between `beginRun()` and the
    // host's first message is real, and a start that failed outright never has
    // a view at all.
    if (agent.view !== null) void agentCancel(agent.view.runId);
  }, [agent.view]);

  // The summary is on the PROPOSAL, not on the end. `LoopEnd` says why the loop
  // stopped; `Proposal.summary` is the model's own words, which in one mode is
  // the answer to a question. Gated on the run having finished so a summary
  // from a previous message is not shown under the next one still running.
  const answered = agent.end !== null && !agent.running;
  const summary = answered ? agent.proposal.summary.trim() : "";

  // A run with something to review. `awaitingScope` is deliberately excluded:
  // a run that stopped to ask has not finished making its proposal, and opening
  // a review over the scope sheet would show a verdict on work in progress
  // while burying the question the run is waiting on.
  // A note the last apply actually wrote, so the version-history offer has
  // somewhere to go. The HOST's list, not the proposal's: an edit can be
  // refused at apply time, and a history sheet for a note nothing changed is a
  // dead end wearing a remedy's label.
  const lastWritten = agent.applied?.notesWritten[0] ?? null;
  /** Before the first probe there is no verdict, so the send is offered and the
   *  check happens on Send. After one, it gates. */
  const probeVerdict = agent.probeVerdict;
  const refused =
    probeVerdict === "failed" ||
    (typeof probeVerdict === "object" && probeVerdict !== null && !probeVerdict.passed);

  const reviewable =
    answered &&
    agent.end?.kind !== "awaitingScope" &&
    (agent.proposal.edits.length > 0 || agent.proposal.newNotes.length > 0);

  return (
    <>
      <ScreenScroll>
        <div data-testid="ai.chat" style={{ padding: "var(--space-3)" }}>
          {/* **The empty state, which the tab had none of.** Opening a
              destination and finding a blank area above a text box reads as a
              screen that failed to load, not as one waiting for you. Desktop's
              chat tab has carried this line since it shipped and mobile
              reuses the key rather than inventing a second sentence for the
              same moment.

              Found by the flow scenario: the container rendered with zero
              height, so `ai.chat` was in the DOM and invisible, and no unit
              test can see that because jsdom computes no layout. */}
          {/* Derived from the RUN, not from `asked`. `asked` is component state
              and the answer lives in a module-scope store, so leaving the tab
              and coming back rendered "nothing here yet" above the previous
              answer, with the question it belongs to gone. */}
          {agent.end === null && !agent.running && agent.error === null && agent.iterations === 0 && (
            <p data-testid="ai.chat-empty" style={MUTED}>
              {t("editor.chrome.rightPanel.aiChat.empty")}
            </p>
          )}

          {asked !== null && (
            // The user's own words, echoed so the answer below has something to
            // be an answer to.
            <p data-testid="ai.chat-asked" style={MUTED}>
              {asked}
            </p>
          )}

          {agent.running && (
            <p data-testid="ai.agent-working" style={MUTED}>
              {t("agent.progress.working")}
            </p>
          )}

          {/* The model's own answer. Not `t()`-wrapped: it is model output, not
              copy. In one mode a question is a run like any other, so the
              summary IS the reply the user asked for rather than a caption over
              a diff. Presented as the model's claim: note content can steer
              it. */}
          {summary.length > 0 && (
            <p data-testid="ai.agent-answer" style={BODY_TEXT}>
              {summary}
            </p>
          )}

          {agent.error !== null && (
            <p role="alert" data-testid="ai.turn-error" style={MUTED}>
              {agent.error}
            </p>
          )}

          {/* **Rendered while the run is in flight, not only after it.** That is
              the whole of what task 5 added on the desktop side and the reason
              the host reports per round-trip at all: the figure this line
              carries is the compensating control for the remote arm having no
              volume bound, and a control that only appears once the spending
              has stopped is disclosure after the fact. Shown whenever a run has
              begun, so a cancelled run still says what it cost. */}
          {(agent.running || answered || agent.iterations > 0) && (
            <RunCostLine
              testId="ai.run-cost"
              iterations={agent.iterations}
              notesRead={agent.notesRead}
              charsOffDevice={agent.charsOffDevice}
              style={COST}
            />
          )}
        </div>
      </ScreenScroll>

      {/* **The undo offer lives OUTSIDE the review screen**
          (`docs/decisions/ai/0518`). It is rendered here rather than in
          `AiReviewFlow` precisely so closing the review does not take it: the
          screen used to own the record, and "the whole run can be undone as one
          action" was therefore true only while the user kept a screen open. */}
      <AiUndoStrip
        {...(onNotesWritten === undefined ? {} : { onReverted: (ids) => onNotesWritten([...ids]) })}
        {...(onOpenHistory === undefined || lastWritten === null
          ? {}
          : { onOpenHistory: () => onOpenHistory(lastWritten) })}
      />

      {/* **The scope and what approving it discloses, on the same screen as the
          button that sends it.** `docs/decisions/ai/0528`: the run opens with
          its scope and the disclosure figure counts. On a phone "the same
          screen" is the load-bearing half, because a figure one tap away is a
          figure nobody read. */}
      <div data-testid="ai.scope-strip" style={SCOPE_STRIP}>
        <span data-testid="ai.scope-label">
          {t("agent.composer.scopeLabel")}{" "}
          {grant === null
            ? t("agent.composer.scopeNone")
            : preview === null
              ? t("agent.composer.scopeCountUnavailable")
              : t("agent.composer.scopeCount", { count: preview.newTotal })}
        </span>
        {/* Stated even at zero: an absent line would have to be read as "no
            exclusions" or as "we did not check", and those are different. */}
        {preview !== null && (
          <span data-testid="ai.scope-excluded">
            {t("agent.scope.excluded", { count: preview.excludedCount })}
          </span>
        )}
        {/* The egress fact, before the first tool call rather than after it. A
            run ships the note-id and title roster of its approved scope before
            it has read anything (docs/threat-model.md TB13, 2026-08-16
            amendment), so "these leave the device" is true from the first
            round-trip and has to be readable before the send, not after. */}
        {arm === "remote" && (
          <span data-testid="ai.scope-egress">
            {t("agent.scope.egressRemote", { provider: providerName ?? "" })}
          </span>
        )}
      </div>

      {/* **The one place a user finds out agent mode is unavailable on the model
          they chose.** Two different failures get two different sentences: a
          verdict that came back failing MEASURED the model, while an
          unanswerable probe measured nothing, and telling that user their model
          is incapable is a diagnosis the inputs cannot support (their provider
          may simply have been unreachable for a moment). */}
      {refused && (
        <p data-testid="ai.composer-unsupported" style={MUTED}>
          {probeVerdict === "failed"
            ? t("agent.composer.unchecked")
            : t("agent.composer.unsupported")}
        </p>
      )}

      <div style={COMPOSER_BAR}>
        <textarea
          data-testid="ai.composer-input"
          // A placeholder is not an accessible name: it disappears on input,
          // and this field is the only entry point to the whole AI surface.
          // The desktop twin carries both.
          aria-label={t("agent.composer.placeholder")}
          style={INPUT}
          rows={1}
          value={draft}
          placeholder={t("agent.composer.placeholder")}
          onChange={(e) => setDraft(e.target.value)}
        />
        {agent.running ? (
          <Button variant="secondary" data-testid="ai.composer-stop" onClick={stop}>
            {t("agent.progress.cancel")}
          </Button>
        ) : (
          <Button
            data-testid="ai.composer-send"
            disabled={draft.trim().length === 0 || grant === null || probing || refused}
            onClick={() => void send()}
          >
            {t("editor.chrome.rightPanel.aiChat.send")}
          </Button>
        )}
      </div>
      {/* **The review OPENS when the run has something to review, and it is
          DERIVED rather than raised as an event.** A run that stopped to ASK is
          not a run to review, and every future path that settles a run would
          otherwise have to remember to open it: the resume after a scope
          approval is a second such path and would have been missed. Closing is
          not a second piece of state either, because `clearAgent()` drops the
          run, which is what makes the rule false again. */}
      {reviewable && (
        <AiReviewFlow
          titleOf={titleOf}
          bodyOf={bodyOf}
          {...(onNotesWritten === undefined ? {} : { onNotesWritten })}
          onClose={() => clearAgent()}
        />
      )}

      {/* NOT gated on a successful preview. The sheet is the only way to answer
          a run that is waiting, and gating it on the fetch would hide the
          decline button too, leaving the run stuck on an answer the user had no
          way to give. */}
      {awaiting !== null && runId !== null && (
        <AiScopeSheet
          folder={awaiting.folder}
          noteCount={expansion?.noteCount ?? null}
          excludedCount={expansion?.excludedCount ?? null}
          newTotal={expansion?.newTotal ?? null}
          reason={awaiting.reason}
          arm={arm}
          providerName={providerName}
          onApprove={() => {
            resumeRun();
            // Captured before the await, so a vault lock during the approval
            // invalidates the reply rather than being raced by it.
            const epoch = currentRunEpoch();
            void agentApproveScope(
              runId,
              { kind: "folder", value: awaiting.folder },
              // The approved leg reports its cost too, or the figures would
              // freeze the moment a run widened its scope, which is precisely
              // when a user most wants to see them moving: widening is what
              // makes a run expensive.
              (progress) => void reportRunProgress(progress, epoch),
            )
              .then((result) => settleStep(result, epoch))
              .catch(() => {
                // Epoch-checked: the success path is guarded transitively by
                // `settleStep`, and a failure that lands after the run was let
                // go of would otherwise clear a NEWER run's `running`.
                if (epoch !== currentRunEpoch()) return;
                failRun(t("agent.progress.expandFailed"));
              });
          }}
          // Declining ENDS the run rather than continuing it narrower. The
          // model asked because it could not finish inside what it had, so
          // "carry on without it" is a promise neither client can keep.
          onDecline={() => void agentCancel(runId)}
        />
      )}
    </>
  );
}
