// The AI tab's one composer.
//
// **Why there is exactly one.** The tab used to mount two: the chat composer
// inside `AiChatTab` and `AgentComposer` beside it, each with its own input and
// its own Send. That was never the recorded design: `docs/decisions/ai/0515`
// puts the agent's entry point in chat, and `AiChatTab`'s own comment claimed
// "the agent surface rides this tab rather than opening a second AI place" while
// the composer sat outside it. Two inputs is not a smaller decision than one; it
// is the same decision, unmade, in front of every user who opens the tab.
//
// **Why the mode is a control rather than an inference.** Reading the message to
// decide whether the user wants an answer or an edit puts that routing on the
// model, and the model is the thing the edit-format probe below exists to
// distrust. The failure is also asymmetric: mistaking a question for an edit
// starts a scope-holding run and spends provider requests, while the reverse
// only costs a re-send. So the user says which, in two words, and the
// consequence is visible before they press anything.
//
// **Two things here are load-bearing rather than layout.**
//
//   1. The scope control. `0515` records it as the mitigation for the
//      model-originated scope expansion, which is the injection-reachable path:
//      "Removing that control does not make the feature smaller; it routes every
//      folder-scale run through the riskier of the two mechanisms." It shows the
//      host's note count before sending, because "Projects" is not a size.
//   2. The probe stays on the first Edit-mode Send. Not on mount, and **not on
//      the mode switch** either: with a remote provider configured the probe
//      issues `threshold.attempts` requests to that provider, and TB13 bars a
//      surface that fires without the user asking. Flipping a segmented control
//      is not asking. Opening the tab and choosing Edit both cost nothing; the
//      Send pays for the check.

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
import { Segmented } from "../../components/primitives/Segmented";
import {
  agentCapability,
  agentPreviewGrant,
  type GrantPreview,
  type ProbeVerdict,
  type ScopeGrant,
} from "../../lib/agent-run";
import { setAutoApply, useAgent } from "../agent/agentStore";
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
  const { t } = useTranslation();
  // Whether the scope picker is expanded. Collapsed by default: the scope shows
  // as text with a control to change it, so the ordinary run reads as one line.
  const [pickerOpen, setPickerOpen] = useState(false);
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
   *  Offering Send during the window between asking and hearing back would be
   *  the same defect the gate exists to close, so `probing` covers that window. */
  const [probe, setProbe] = useState<ProbeVerdict | "failed" | null>(null);
  const [probing, setProbing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const verdict = typeof probe === "object" ? probe : null;

  /** Run the probe, at most once per mounted composer. See the module note for
   *  why it is not fired on mount or on the mode switch. */
  async function ensureCapability(): Promise<ProbeVerdict | null> {
    if (verdict !== null) return verdict;
    setProbing(true);
    try {
      const v = await agentCapability();
      setProbe(v);
      return v;
    } catch {
      // Fail CLOSED. An unanswerable probe is not evidence that the backend can
      // hold the format, and offering the run anyway is what this gate exists
      // to prevent.
      setProbe("failed");
      return null;
    } finally {
      setProbing(false);
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
  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [message]);

  const scopeOptions = useMemo(
    () => [
      { value: "", label: t("agent.composer.scopeOpenNote") },
      ...folders.map((f) => ({ value: f, label: f })),
    ],
    [folders, t],
  );
  // `SearchableSelect` memoizes its selected set and its trigger summary on this
  // array's identity, so a literal would rebuild both on every keystroke and on
  // every streamed token.
  const scopeSelected = useMemo(() => [attached ?? ""], [attached]);

  // `Segmented` measures its thumb in a layout effect keyed on `options`, so a
  // literal forces a synchronous layout read AND a second commit on every
  // render. During streaming that is once per token, to move a thumb that has
  // not moved.
  const permissionOptions = useMemo(
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

  async function submit(): Promise<void> {
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
        },
        onNotesWritten,
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

      {/* The user-originated scope control, and the size it resolves to. Only in
          Edit mode: in Ask mode the grounding is the whole vault's index and
          there is nothing here for the user to grant. */}
      {
        <div style={ROW_STYLE}>
          <span style={CAPTION_STYLE}>{t("agent.composer.scopeLabel")}</span>
          {/* **The picker is one step back, and the scope is not** (issue A).
              The common run is the open note, and reading a dropdown before
              typing is friction for a choice almost nobody changes. What may
              NOT move is the control itself or the count beside it:
              `docs/decisions/ai/0518` point 1 requires a user-originated scope
              control on the composer, because removing it routes every
              folder-scale run through the model-originated expansion instead,
              which is the injection-reachable path. So this changes prominence
              and nothing else, and the count below still renders whenever a
              folder is attached. */}
          {pickerOpen ? (
            <SearchableSelect
              testId="ai.composer-scope"
              aria-label={t("agent.composer.scopeLabel")}
              options={scopeOptions}
              selected={scopeSelected}
              onChange={(next) => {
                setAttached(next[0] ? next[0] : null);
                setPickerOpen(false);
              }}
            />
          ) : (
            <>
              <span data-testid="ai.composer-scope-current" style={CAPTION_STYLE}>
                {attached ?? t("agent.composer.scopeOpenNote")}
              </span>
              <Button
                type="button"
                variant="ghost"
                data-testid="ai.composer-scope-change"
                onClick={() => setPickerOpen(true)}
              >
                {t("agent.composer.scopeChange")}
              </Button>
            </>
          )}
          {/* **A failed preview says so rather than showing nothing.** An
              absent count reads as "no folder attached", and the count before
              sending is part of the mitigation `docs/decisions/ai/0515` names,
              not a nicety. The expansion dialog already distinguishes "could
              not find out" from "zero" for the same reason. */}
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
        </div>
      }

      {/* **The permission control** (myne-md/myne#551). Edit mode only: Ask
          proposes nothing, so there is nothing for it to decide. What the
          automatic side is bounded by is stated where it is enforced
          (`autoApplyRun`), not here — the summary is that it stays inside the
          scope the user approved and that a removal still needs its own act,
          because the host refuses one inside a bulk approval whatever the
          caller sends. */}
      {
        <Segmented
          testId="ai.composer-permission"
          ariaLabel={t("agent.composer.permissionLabel")}
          value={agent.autoApply ? "auto" : "ask"}
          onChange={(v) => setAutoApply(v === "auto")}
          options={permissionOptions}
        />
      }

      <form
        onSubmit={(e) => {
          e.preventDefault();
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
            // syllable they meant to accept.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={t("agent.composer.placeholder")}
          aria-label={t("agent.composer.placeholder")}
          disabled={busy}
          style={INPUT_STYLE}
        />
        <Button
          type="submit"
          variant="primary"
          data-testid="ai.composer-send"
          disabled={blocked}
        >
          {probing
            ? t("agent.composer.checking")
            : t("editor.chrome.rightPanel.aiChat.send")}
        </Button>
      </form>
    </div>
  );
}
