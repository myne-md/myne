// The AI tab's one composer.
//
// **Why there is exactly one.** The tab used to mount two: the chat composer
// inside `AiChatTab` and `AgentComposer` beside it, each with its own input and
// its own Send. That was never the recorded design: `design-notes/ai/0515`
// puts the agent's entry point in chat, and `AiChatTab`'s own comment claimed
// "the agent surface rides this tab rather than opening a second AI place" while
// the composer sat outside it. Two inputs is not a smaller decision than one; it
// is the same decision, unmade, in front of every user who opens the tab.
//
// **There is no Ask/Edit control any more** (myne-md/myne#552,
// `design-notes/ai/0524`). Every message starts an agent run: the agent
// answers a question with its `finish` summary and proposes edits when that is
// what was asked for. The segment that used to choose the flow now chooses the
// permission mode. The asymmetry the old control was justified by has not
// changed and is not being denied — it is that in one mode every message
// deliberately pays the expensive side, because the expensive side can now
// answer questions too (`search_vault`, `0523`).
//
// **Two things here are load-bearing rather than layout.**
//
//   1. The scope control. `0515` records it as the mitigation for the
//      model-originated scope expansion, which is the injection-reachable path:
//      "Removing that control does not make the feature smaller; it routes every
//      folder-scale run through the riskier of the two mechanisms." It shows the
//      host's note count before sending, because "Projects" is not a size.
//   2. The probe stays on the first Send. Not on mount, and not on a control
//      change either: with a remote provider configured the probe issues
//      `threshold.attempts` requests to that provider, and TB13 bars a surface
//      that fires without the user asking. Opening the tab costs nothing; the
//      Send pays for the check. What myne-md/myne#568 changed is only how long
//      one answer LIVES — the verdict is session state in `agentStore` rather
//      than this component's, so a tab switch no longer re-buys it — never when
//      it is bought.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../components/primitives/Button";
import { SearchableSelect } from "../../components/primitives/SearchableSelect";
import { Select, type SelectOption } from "../../components/primitives/Select";
import { Spinner } from "../../components/Spinner";
import {
  agentCancel,
  agentCapability,
  agentPreviewGrant,
  type GrantPreview,
  type ProbeProgress,
  type ProbeVerdict,
  type ScopeGrant,
} from "../../lib/agent-run";
import { providerErrorKey } from "../../lib/engine-error";
import {
  getAgent,
  setAutoApply,
  setProbeVerdict,
  useAgent,
} from "../agent/agentStore";
import { startAgentRun } from "../ai/agentToChat";
import { CAPTION_STYLE } from "./sharedStyles";

export interface ChatComposerProps {
  /** The open note: the default scope when no folder is attached. */
  openNoteId: string | null;
  /** Folders the user can attach as a scope. */
  folders: readonly string[];
  /** Called with the ids of notes an automatic apply wrote, so the open pane
   *  re-reads them. Without it the editor keeps showing the pre-apply text and
   *  the pane's next autosave writes that stale buffer back over the edit. */
  onNotesWritten?: (noteIds: readonly string[]) => void;
}

const INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  // Auto-grown by the effect below; these two bound it. Neither is a spacing
  // token the theme owns, so neither is a hardcoded visual value.
  minHeight: 32,
  maxHeight: 132,
  resize: "none",
  overflowY: "auto",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.4,
  color: "var(--fg-1)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "var(--space-1) var(--space-2)",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2)",
};

export function ChatComposer({
  openNoteId,
  folders,
  onNotesWritten,
}: ChatComposerProps) {
  // `i18n` for its `language`, which the agent run sends to the host: the
  // chosen language lives in this side's localStorage, so the backend has no
  // way to read it, and without it a run answers a Turkish question in English.
  const { t, i18n } = useTranslation();
  // Whether the scope picker is expanded. Collapsed by default: the scope shows
  // as text with a control to change it, so the ordinary run reads as one line.
  // The permission mode lives in the run store rather than here: it is
  // session-scoped and has to be dropped by the same lock teardown that drops
  // the run, which a component's own state cannot be.
  const agent = useAgent();
  const [message, setMessage] = useState("");
  const [attached, setAttached] = useState<string | null>(null);
  const [preview, setPreview] = useState<GrantPreview | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  /** Whether the configured backend can hold the anchored edit format.
   *
   *  Three states in one field rather than a verdict plus a boolean: unasked,
   *  refused-because-unanswerable, and a verdict that speaks for itself. The
   *  two-field version admitted a fourth combination nothing intended, and its
   *  reset path was unreachable, because once the probe has failed the composer
   *  is blocked, so `ensureCapability` can never run again to clear it.
   *
   *  **In the run store rather than here** (myne-md/myne#568). It used to be
   *  this component's own `useState`, so every remount asked again: with a
   *  remote provider that is `threshold.attempts` requests, 8 seconds in the
   *  session that found it, and `AiChatTab` remounts on an ordinary tab switch
   *  in the right panel. The store keeps it for the session and
   *  `clearAgentForLock` drops it, which is the teardown a component cannot
   *  have. WHEN the probe fires has not changed: still the first Send. */
  const probe = agent.probeVerdict;
  /** Offering Send during the window between asking and hearing back would be
   *  the same defect the gate exists to close, so this covers that window.
   *  Component state on purpose, unlike the verdict: it describes a call this
   *  composer has in flight, and a composer that unmounts takes it with it. */
  const [probing, setProbing] = useState(false);
  /** Which attempt the probe is on, while it is on one (myne-md/myne#575).
   *
   *  Component state beside `probing`, and for the same reason: it describes a
   *  call THIS composer has in flight, so a composer that unmounts takes it
   *  with it. The VERDICT is the thing that has to outlive the component, and
   *  it lives in the store. */
  const [probeAt, setProbeAt] = useState<ProbeProgress | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const verdict = typeof probe === "object" ? probe : null;

  /** Run the probe, at most once per session. See the module note for why it is
   *  not fired on mount or on a control change. */
  async function ensureCapability(): Promise<ProbeVerdict | null> {
    // Read through the store rather than trusting this render's snapshot: a
    // sibling composer, or this one after a remount, may have paid for the
    // answer already.
    const known = getAgent().probeVerdict;
    if (typeof known === "object" && known !== null) return known;
    setProbing(true);
    try {
      const v = await agentCapability(setProbeAt);
      setProbeVerdict(v);
      return v;
    } catch {
      // Fail CLOSED. An unanswerable probe is not evidence that the backend can
      // hold the format, and offering the run anyway is what this gate exists
      // to prevent.
      setProbeVerdict("failed");
      return null;
    } finally {
      setProbing(false);
      setProbeAt(null);
    }
  }

  // The count comes from the HOST, resolved by the same code the commit runs.
  // Counting here would leave out the `ai_excluded_folders` clamp, so the number
  // shown before sending would be larger than the scope the user actually gets.
  //
  // **Cleared FIRST, and a failure is its own value.** Leaving the previous
  // answer up while the next one resolves showed one folder's size beside
  // another folder's name, and collapsing a failed call into `null` made "we
  // could not find out" look identical to "nothing is attached".
  useEffect(() => {
    setPreview(null);
    if (attached === null) return;
    let live = true;
    void agentPreviewGrant({ kind: "folder", value: attached })
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch(() => {
        if (live) setPreview("failed");
      });
    return () => {
      live = false;
    };
  }, [attached]);

  // Grow the input with its content, up to the cap in `INPUT_STYLE`. Measured
  // rather than counted from newlines, so a long wrapped line grows too.
  //
  // **An EMPTY input is one row, whatever the placeholder does.** `scrollHeight`
  // measures the rendered text, and a textarea with no value renders its
  // placeholder — so a placeholder that wraps at panel width reported two lines
  // and the box opened two rows tall before the user had typed anything. The
  // height would then be a property of the COPY: translate the placeholder into
  // a longer language and the empty composer grows, in every locale, with
  // nothing in the code to point at.
  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    if (message === "") return;
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [message]);

  /**
   * The scope choices.
   *
   * **The open-note entry is offered only when there IS one** (myne-md/myne#771).
   * It was unconditional and labelled "This note", so in the agent tab — where
   * the tab is usually the focused pane and no note is open — the picker's one
   * entry named something that did not exist, resolved to `null`, and left Send
   * permanently disabled with no other scope in the list to pick instead. A
   * control lying about its own value is worse than one with nothing in it:
   * the user reads "This note" and concludes the app is broken rather than
   * that they have a choice to make.
   */
  const scopeOptions = useMemo(
    () => [
      ...(openNoteId !== null && openNoteId !== ""
        ? [{ value: "", label: t("agent.composer.scopeOpenNote") }]
        : []),
      ...folders.map((f) => ({ value: f, label: f })),
    ],
    [folders, openNoteId, t],
  );
  // `SearchableSelect` memoizes its selected set and its trigger summary on this
  // array's identity, so a literal would rebuild both on every keystroke and on
  // every streamed token.
  const scopeSelected = useMemo(() => [attached ?? ""], [attached]);

  // Memoized for the same reason every options list on this surface is: the
  // transcript re-renders once per streamed token, and a fresh array identity
  // per render is a fresh identity handed to every consumer downstream. (It was
  // `Segmented`'s layout-effect thumb measurement that made it load-bearing
  // rather than tidy; the control is a `<Select>` now and the habit is still
  // right.)
  const permissionOptions: readonly SelectOption<"ask" | "auto">[] = useMemo(
    () => [
      { value: "ask", label: t("agent.composer.permissionAsk") },
      { value: "auto", label: t("agent.composer.permissionAuto") },
    ],
    [t],
  );

  const grant: ScopeGrant | null = attached
    ? { kind: "folder", value: attached }
    : openNoteId
      ? { kind: "notes", value: [openNoteId] }
      : null;

  // Before the first probe there is no verdict, so Edit mode is offered and the
  // check happens on Send. After one, it gates.
  const refused = probe === "failed" || verdict?.passed === false;
  const empty = message.trim().length === 0;
  const blocked = empty || busy || probing || refused || grant === null;
  // While a run works there is no second Stop control: this button turns
  // into it, in place, like the mobile composer already does. The id may
  // genuinely be null on the first leg (before `agentStart` reports the
  // view), and then the tap has nothing to address yet.
  const running = agent.running;
  const runId = agent.view?.runId ?? null;

  function stop(): void {
    if (runId !== null) void agentCancel(runId);
  }

  async function submit(): Promise<void> {
    if (running) return;
    if (blocked) return;
    const text = message.trim();
    if (grant === null) return;
    const verdict = await ensureCapability();
    // The refusal is rendered by the notice below; keep what the user typed so
    // switching backend and sending again does not cost them the message.
    if (verdict === null || !verdict.passed) return;
    setMessage("");
    setBusy(true);
    try {
      await startAgentRun(
        text,
        grant,
        {
          scopeLabel: attached ?? t("agent.composer.scopeOpenNote"),
          startFailed: t("agent.composer.startFailed"),
          autoApplyFailed: t("agent.composer.autoApplyFailed"),
          providerRejected: t("agent.composer.providerRejected"),
          // Resolved through the shared taxonomy key rather than a second
          // chat-only key, so this turn and the mobile run-failure banner read
          // the same sentence by construction (myne-md/myne#675).
          scopeExcluded: t(providerErrorKey("empty_grant")),
        },
        i18n.language || null,
        onNotesWritten,
        // Anchor the conversation to the note when the run is about one note
        // (myne-md/myne#771). A folder or multi-note run is vault-general and
        // gets no anchor, which is what the Hub renders as "not anchored".
        grant.kind === "notes" && grant.value.length === 1 ? grant.value[0]! : null,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="ai.composer"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        paddingTop: "var(--space-2)",
        borderTop: "1px solid var(--line-1)",
      }}
    >
      {/* The capability verdict, stated rather than implied by a dead button.
          This is the one place a user finds out that agent mode is unavailable
          on the model they chose. */}
      {refused ? (
        <div
          data-testid="ai.composer-unsupported"
          style={{
            padding: "var(--space-2)",
            borderRadius: "var(--radius-1)",
            background: "var(--bg-2)",
            color: "var(--fg-2)",
            fontSize: "var(--text-sm)",
          }}
        >
          {/* **Two different failures, two different sentences.** A verdict that
              came back failing measured the model. An unanswerable probe
              measured nothing, and telling that user their model is incapable
              and to choose another one is a diagnosis the inputs cannot
              support: their provider may simply have been unreachable for a
              moment. */}
          {verdict === null
            ? t("agent.composer.unchecked")
            : t("agent.composer.unsupported")}
          {verdict !== null ? (
            <>
              {" "}
              {t("agent.composer.unsupportedDetail", {
                passes: verdict.passes,
                attempts: verdict.threshold.attempts,
                required: verdict.threshold.required,
              })}
              {verdict.threshold.provisional ? (
                <> {t("agent.composer.unsupportedProvisional")}</>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          // While a run works the button below is Stop, so this form never
          // submits: only the button stops a run, never a stray Enter from
          // typing the next message.
          if (running) return;
          void submit();
        }}
        style={{ display: "flex", alignItems: "flex-end", gap: "var(--space-2)" }}
      >
        <textarea
          ref={inputRef}
          data-testid="ai.composer-input"
          rows={1}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line. `isComposing` is the
            // load-bearing half: an IME commits its candidate with Enter, so
            // without it a Turkish, Japanese or Korean user sends the first
            // syllable they meant to accept. While a run works Enter does
            // nothing: stopping is the button's job, never a keystroke typed
            // into the next message.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (running) return;
              void submit();
            }
          }}
          placeholder={t("agent.composer.placeholder")}
          aria-label={t("agent.composer.placeholder")}
          disabled={busy}
          style={INPUT_STYLE}
        />
        {running ? (
          <Button
            type="button"
            variant="secondary"
            data-testid="ai.composer-stop"
            disabled={runId === null}
            onClick={stop}
          >
            {t("agent.progress.cancel")}
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            data-testid="ai.composer-send"
            disabled={blocked}
          >
            {/* The label does NOT change with the probe. It did, and the label
                it changed to was long enough to collapse the textarea beside
                it: a button that resizes while you are typing into the control
                it is stealing width from. The spinner says work is in flight,
                the count is in the row above, and the button stays the size it
                was. */}
            {probing ? <Spinner size={14} style={{ borderWidth: 2 }} /> : null}
            {t("editor.chrome.rightPanel.aiChat.send")}
          </Button>
        )}
      </form>

      {/* **A disabled Send says why** (myne-md/myne#771). A run needs a scope
          the host will accept: `defaultGrantFor` resolves it to the open note
          or to `null`, and a vault-wide grant is refused outright
          (`is_root_grant`). So with no note open and no folder chosen there is
          genuinely nothing to run against — and the surface said so with a
          greyed button and nothing else, which reads as a broken app rather
          than as a choice the user has not made yet.

          Only when there is something to send: a scope missing while the box
          is empty is not yet a problem, and a line that appears before the
          user has typed is a scolding. */}
      {grant === null && !empty && !busy ? (
        <p data-testid="ai.composer-needs-scope" style={CAPTION_STYLE}>
          {t("agent.composer.needsScope")}
        </p>
      ) : null}

      {/* **One control row, UNDER the input** (myne-md/myne#771). The scope and
          the permission mode were two full-width rows ABOVE it — a caption, a
          value and a Change button on one; a segmented control spanning the
          panel on the other — which in a 280px side panel is a quarter of the
          surface spent on two choices almost nobody changes per message, sat
          between the transcript and the thing you came to type in.

          Below the input rather than above it, because that is the order the
          two are used in: you type, and the settings are what you glance at
          before sending. Above, they were two rows of chrome to read past on
          the way to the composer, every time.

          The scope control itself may NOT be removed, and this does not remove
          it: `design-notes/ai/0518` point 1 requires a user-originated scope
          control on the composer, because taking it away routes every
          folder-scale run through the model-originated expansion instead, which
          is the injection-reachable path. What changes is that it costs one row
          instead of two, and one click instead of two. */}
      <div style={ROW_STYLE}>
        {/* **The picker is the control, not a disclosure over one.** It used to
            render a caption plus a Change button, and pressing Change REPLACED
            them with this same `SearchableSelect` — whose trigger you then
            pressed to open the menu. Two clicks and a layout shift to reach a
            control that already is a disclosure, in service of an argument
            ("reading a dropdown before typing is friction") that the two-step
            version cost more of than the dropdown ever did. */}
        <SearchableSelect
          testId="ai.composer-scope"
          aria-label={t("agent.composer.scopeLabel")}
          options={scopeOptions}
          selected={scopeSelected}
          // The placeholder is what the trigger reads when nothing is chosen,
          // so it names the CHOICE rather than a value: with no note open there
          // is nothing selected and "This note" would be the same lie the
          // option list used to tell.
          placeholder={
            openNoteId !== null && openNoteId !== ""
              ? t("agent.composer.scopeOpenNote")
              : t("agent.composer.scopeChoose")
          }
          onChange={(next) => setAttached(next[0] ? next[0] : null)}
        />

        {/* **The permission mode is a dropdown, not a segmented control**
            (myne-md/myne#771). A segment is for a choice you flip often enough
            that both options should be one click away; this one is set once and
            left, and it was spending a full panel-width row saying so. What the
            automatic side is bounded by is stated where it is enforced
            (`autoApplyRun`), not here: it stays inside the scope the user
            approved, and a removal still needs its own act because the host
            refuses one inside a bulk approval whatever the caller sends. */}
        <Select
          testId="ai.composer-permission"
          aria-label={t("agent.composer.permissionLabel")}
          value={agent.autoApply ? "auto" : "ask"}
          onChange={(v: "ask" | "auto") => setAutoApply(v === "auto")}
          options={permissionOptions}
        />

        {/* **A failed preview says so rather than showing nothing.** An absent
            count reads as "no folder attached", and the count before sending is
            part of the mitigation `design-notes/ai/0515` names, not a nicety.
            The expansion dialog already distinguishes "could not find out" from
            "zero" for the same reason. */}
        {preview === "failed" ? (
          <span data-testid="ai.composer-scope-unavailable" style={CAPTION_STYLE}>
            {t("agent.composer.scopeCountUnavailable")}
          </span>
        ) : null}
        {attached !== null && preview !== null && preview !== "failed" ? (
          <>
            <span data-testid="ai.composer-scope-count" style={CAPTION_STYLE}>
              {t("agent.composer.scopeCount", { count: preview.noteCount })}
            </span>
            {preview.excludedCount > 0 ? (
              <span data-testid="ai.composer-scope-excluded" style={CAPTION_STYLE}>
                {t("agent.scope.excluded", { count: preview.excludedCount })}
              </span>
            ) : null}
          </>
        ) : null}

        {/* The probe's progress, here rather than inside the Send button.
            The button's label grew to "Checking the model… (2/3)", which in a
            flex row with a `flex: 1` textarea meant the input collapsed to
            three characters wide mid-keystroke — the user's own text squeezed
            out of the way by a status about the model. A caption in a row that
            already exists costs nothing and moves nothing. */}
        {probing && probeAt !== null ? (
          <span data-testid="ai.composer-probe-at" style={CAPTION_STYLE}>
            {t("agent.composer.checkingAt", {
              attempt: probeAt.attempt,
              of: probeAt.of,
            })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
