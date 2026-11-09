// "Teach Myne your vault": the reviewed seed wizard and the Settings row that
// opens it (myne-md/myne#915).
//
// Three steps, and each one exists to answer a question the user cannot answer
// from the previous one:
//
//   1. SCOPE. What will be sent, to whom, how much. The payload is the real
//      string the host will use, not a summary of it, because "local" is a fact
//      the user can check rather than one the UI asserts. A remote provider
//      needs an explicit confirmation HERE, and the host refuses the run
//      without it.
//   2. CANDIDATES. Three to ten entries the model distilled. Every line is
//      read before it is written, which is the human gate the whole feature
//      rests on.
//   3. APPLIED. What landed, and the way to remove it.
//
// Nothing is written until step three, and the apply command re-validates every
// entry host-side (cap, schema, injection scan) rather than trusting this
// component. A refusal names its candidate index and leaves the rest of the
// batch selectable, so a single bad line never costs the whole run.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../primitives/Button";
import { ModalShell } from "../primitives/ModalShell";
import { useSelectedNoteOptional } from "../../notes/sidebarState";
import { usePrefs } from "../../hooks/usePrefs";
import { providerLabelOf } from "../../lib/ai-capability";
import { Textarea } from "../primitives/Textarea";
import { MIN_TARGET } from "../primitives/targetSize";
import { toast } from "../toast/toastStore";
import {
  isSeedStale,
  memorySeedApply,
  seedMemoryCancel,
  seedMemoryGenerate,
  seedMemoryPayload,
  seedMemoryStatus,
  type SeedCandidateRefusal,
  type SeedPayload,
  type SeedProgress,
  type SeedStatus,
} from "../../lib/seed-memory";

type Step = "scope" | "candidates";

const BLOCK: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  // The modal body is a bare flex child (`ModalShell` supplies chrome and no
  // padding), so every ModalShell caller owns its inset. Horizontally this is
  // the same `--space-5` the header's title uses, which is what makes the title
  // and the body read as one column; the body scrolls rather than clipping when
  // a candidate list is long.
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-4) var(--space-5) var(--space-5)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};

const HELPER: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const PRE: CSSProperties = {
  margin: 0,
  maxHeight: 240,
  overflow: "auto",
  padding: "var(--space-2)",
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-1)",
  background: "var(--paper)",
  color: "var(--fg-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const LIST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
  maxHeight: 360,
  overflowY: "auto",
};

const CARD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-2)",
  border: "1px solid var(--line-1)",
  background: "var(--paper-2)",
};

const ACTIONS: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
};

/** The scope's numbers, as chips (issue #970, item 8).
 *
 *  They used to be one dot-separated sentence, "171 notes · 41 folders · 22
 *  tags", which reads as prose about the vault rather than as four facts about
 *  the thing being sent. A chip is the app's shape for a short countable fact
 *  (the tag editor and the filter bar both use it), and it makes the row
 *  scannable at a glance, which is what a consent screen's numbers should be. */
const FACTS: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2)",
  margin: 0,
};

const FACT_CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px var(--space-2)",
  borderRadius: "var(--radius-2)",
  border: "1px solid var(--line-1)",
  background: "var(--paper-2)",
  color: "var(--fg-2)",
  fontSize: "var(--text-xs)",
  whiteSpace: "nowrap",
};

/** The candidate's header row: the label for its own checkbox, sized so the
 *  whole line is clickable. */
const CANDIDATE_HEAD: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  alignItems: "center",
  cursor: "pointer",
};

/** The selection box itself, at the WCAG pointer floor rather than the browser's
 *  13px default. `accent-color` keeps it the accent rather than the platform's
 *  blue, which is what it was in the report. */
const SELECT_BOX: CSSProperties = {
  ...MIN_TARGET,
  width: "var(--target-min)",
  height: "var(--target-min)",
  margin: 0,
  accentColor: "var(--accent)",
  cursor: "pointer",
};

/** An unselected entry stays readable but stops competing for attention: its
 *  text is dimmed rather than removed, because the decision is reversible right
 *  up until Save. */
const UNSELECTED_CARD: CSSProperties = {
  opacity: 0.55,
};

/** A textarea long enough to show its entry, capped so the Save button stays on
 *  the modal (issue #970, item 10). ~72 characters per line at the body's width,
 *  which is a rough measure on purpose: one row of error in either direction
 *  costs nothing, a clipped sentence costs the review. */
const MAX_CANDIDATE_ROWS = 8;
function candidateRows(text: string): number {
  return Math.min(MAX_CANDIDATE_ROWS, Math.max(3, Math.ceil(text.length / 72) + 1));
}

/** The run's own state, in the wizard's body rather than in a box of its own
 *  (issue #970, item 9). */
const PROGRESS_BLOCK: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  margin: 0,
};

const PROGRESS_TRACK: CSSProperties = {
  height: 4,
  borderRadius: "var(--radius-1)",
  background: "var(--line-1)",
  overflow: "hidden",
};

// A scale on the compositor rather than a width on the main thread: a width
// transition lays out and paints every frame, and `motion-canon` refuses it for
// that reason (PRODUCT.md principle 4, decisions/ui/0632). `scaleX` with the
// origin pinned left draws exactly the same bar.
const PROGRESS_FILL: CSSProperties = {
  height: "100%",
  background: "var(--accent)",
  transformOrigin: "left center",
  transition: "transform var(--duration-fast) var(--ease-out, ease)",
};

/** The provider line: a sentence, not a chip, because it names a party rather
 *  than counting something. */
const PROVIDER_LINE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs)",
  color: "var(--fg-2)",
};

/** Translate a seed/apply failure into a sentence that names its cause. */
function seedErrorKey(kind: string | undefined): string {
  switch (kind) {
    case "AiDisabled":
      return "settings.memory.seed.errors.aiDisabled";
    case "SlotNotUnlocked":
      return "settings.memory.seed.errors.locked";
    case "JobBusy":
      return "settings.memory.seed.errors.busy";
    case "RemoteConsentRequired":
      return "settings.memory.seed.errors.consent";
    case "VaultUnreadable":
      return "settings.memory.seed.errors.unreadable";
    case "MalformedOutput":
      return "settings.memory.seed.errors.malformed";
    case "Cancelled":
      return "settings.memory.seed.errors.cancelled";
    case "NoBodiesReadable":
      return "settings.memory.seed.errors.noBodies";
    case "Engine":
      return "settings.memory.seed.errors.engine";
    default:
      return "settings.memory.seed.errors.unknown";
  }
}

interface CandidateDraft {
  text: string;
  selected: boolean;
  refusal?: SeedCandidateRefusal;
}

function progressKey(phase: string): string {
  switch (phase) {
    case "projecting":
      return "settings.memory.seed.phases.projecting";
    case "asking":
      return "settings.memory.seed.phases.asking";
    case "reading":
      return "settings.memory.seed.phases.reading";
    case "finalizing":
      return "settings.memory.seed.phases.finalizing";
    default:
      return "settings.memory.seed.phases.working";
  }
}

/** The wizard. Mounted by the Settings row and by the chat zero-state card. */
export function SeedMemoryWizard(props: {
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const { t } = useTranslation();
  // Only to NAME the provider on the scope screen: the engine reports its own id
  // ("remote"), and the human label lives in the preferences.
  const { prefs } = usePrefs();
  const [step, setStep] = useState<Step>("scope");
  const [status, setStatus] = useState<SeedStatus | null>(null);
  const [payload, setPayload] = useState<SeedPayload | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<SeedProgress | null>(null);
  const [candidates, setCandidates] = useState<CandidateDraft[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [capDetail, setCapDetail] = useState<{ remaining: number; requested: number } | null>(
    null,
  );
  const jobIdRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    setStep("scope");
    setConsent(false);
    setExpanded(false);
    setProgress(null);
    setCandidates([]);
    setRunError(null);
    setCapDetail(null);
  }, []);

  useEffect(() => {
    if (!props.open) {
      reset();
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const [nextStatus, nextPayload] = await Promise.all([
          seedMemoryStatus(),
          seedMemoryPayload(),
        ]);
        if (cancelled) return;
        setStatus(nextStatus);
        setPayload(nextPayload);
        // A remote provider is never pre-consented: the checkbox starts empty on
        // every open, and the host re-checks the flag it is given.
        setConsent(false);
      } catch (e) {
        if (cancelled) return;
        setLoadError(seedErrorKey((e as { kind?: string }).kind));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.open, reset]);

  const close = useCallback(() => {
    if (jobIdRef.current !== null) {
      void seedMemoryCancel(jobIdRef.current);
      jobIdRef.current = null;
    }
    props.onClose();
  }, [props]);

  const generate = useCallback(async () => {
    setRunError(null);
    // Move to the candidates step BEFORE the call, because that is where the
    // progress and the cancel control live. A failure returns to the scope
    // step with the cause stated there.
    setStep("candidates");
    setGenerating(true);
    setProgress(null);
    // A cancellation key, not a secret: uniqueness within this view is all it
    // needs, and `crypto.randomUUID` is not available in every WebView build.
    const jobId = `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    jobIdRef.current = jobId;
    try {
      const result = await seedMemoryGenerate(jobId, consent, setProgress);
      setCandidates(
        result.candidates.map((candidate) => ({ text: candidate.text, selected: true })),
      );
      setStep("candidates");
    } catch (e) {
      setRunError(seedErrorKey((e as { kind?: string }).kind));
      setStep("scope");
    } finally {
      jobIdRef.current = null;
      setGenerating(false);
      setProgress(null);
    }
  }, [consent]);

  const cancelRun = useCallback(() => {
    if (jobIdRef.current !== null) void seedMemoryCancel(jobIdRef.current);
  }, []);

  const apply = useCallback(async () => {
    const chosen = candidates.filter((c) => c.selected && c.text.trim().length > 0);
    if (chosen.length === 0) return;
    setApplying(true);
    setRunError(null);
    setCapDetail(null);
    try {
      const outcome = await memorySeedApply(
        chosen.map((c) => c.text),
        (status?.seedEntries ?? 0) > 0,
      );
      // **The wizard closes and the outcome is a toast** (issue #970, item 11).
      // The third step was a 720px dialog holding two sentences and a Done
      // button, drawn over the Memory section that already lists every entry it
      // was talking about: "Saved 9 entries" was the group header behind it, and
      // "find them under From your vault" described a list the user could see.
      // Nothing is lost by leaving the screen: the count is in the message, the
      // entries are in the panel, and `onApplied` is what makes the panel show
      // them.
      props.onApplied?.();
      toast({
        message: t("settings.memory.seed.applied", { count: outcome.ids.length }),
        variant: "success",
      });
      close();
    } catch (e) {
      const err = e as { kind?: string; detail?: unknown };
      if (err.kind === "SeedCandidateRefused") {
        const detail = err.detail as { index?: number; reason?: SeedCandidateRefusal };
        if (typeof detail?.index === "number") {
          setCandidates((prev) =>
            prev.map((candidate, index) =>
              index === detail.index ? { ...candidate, refusal: detail.reason } : candidate,
            ),
          );
        }
        setRunError("settings.memory.seed.errors.candidateRefused");
      } else if (err.kind === "SeedCapExceeded") {
        const detail = err.detail as { remaining?: number; requested?: number };
        setCapDetail({
          remaining: detail?.remaining ?? 0,
          requested: detail?.requested ?? chosen.length,
        });
        setRunError("settings.memory.seed.errors.cap");
      } else {
        setRunError(seedErrorKey(err.kind));
      }
    } finally {
      setApplying(false);
    }
  }, [candidates, props, status]);

  // **One provider name, both sentences that state it** (issue #970, item 8).
  // The engine reports its own id, and the remote arm's id is literally
  // "remote", a class, not a provider. The label only exists in the
  // preferences, which is where the AI chat notice and the panel's caption read
  // it from too, so all three name the same provider the same way.
  const providerName = providerLabelOf(prefs.ai_provider) ?? status?.provider ?? "";

  const title =
    step === "scope"
      ? t("settings.memory.seed.title")
      : t("settings.memory.seed.candidatesTitle");

  return (
    <ModalShell
      open={props.open}
      onClose={close}
      labelId="seed-memory-title"
      title={title}
      width={720}
      testId="settings.memory.seed.wizard"
      closeLabel={t("common.close")}
      canDismiss={() => !generating && !applying}
    >
      {step === "scope" ? (
        <div style={BLOCK} data-testid="settings.memory.seed.scope">
          {loading ? <p style={HELPER}>{t("settings.memory.seed.loading")}</p> : null}
          {loadError !== null ? (
            <p data-testid="settings.memory.seed.load-error" style={HELPER}>
              {t(loadError)}
            </p>
          ) : null}
          {runError !== null ? (
            <p
              data-testid="settings.memory.seed.run-error"
              style={{ ...HELPER, color: "var(--danger)" }}
            >
              {t(runError)}
            </p>
          ) : null}
          {payload !== null && status !== null ? (
            <>
              <p style={HELPER}>{t("settings.memory.seed.scopeIntro")}</p>
              {/* **The provider line names the provider, once** (issue #970,
                  item 8). It read "Provider: remote · remote": `status.provider`
                  is the ENGINE's id (`RemoteEngine::ID` is literally "remote"),
                  and the class was appended after it, so the same word appeared
                  twice and the actual provider never appeared at all. The name
                  only exists in the preferences, exactly as the AI chat notice
                  and the panel's own caption resolve it, so it is resolved the
                  same way here: `providerLabelOf(prefs.ai_provider)`, with the
                  engine id kept only as a last resort for a build whose provider
                  is unset (where the run would be refused anyway). */}
              <p data-testid="settings.memory.seed.provider" style={PROVIDER_LINE}>
                {status.remote
                  ? t("settings.memory.seed.provider", {
                      provider: providerName,
                    })
                  : t("settings.memory.seed.providerLocalName")}
              </p>
              <p style={FACTS}>
                <span data-testid="settings.memory.seed.count-notes" style={FACT_CHIP}>
                  {t("settings.memory.seed.countNotes", { count: payload.notes })}
                </span>
                <span data-testid="settings.memory.seed.count-folders" style={FACT_CHIP}>
                  {t("settings.memory.seed.countFolders", { count: payload.folders })}
                </span>
                <span data-testid="settings.memory.seed.count-tags" style={FACT_CHIP}>
                  {t("settings.memory.seed.countTags", { count: payload.tags })}
                </span>
                <span data-testid="settings.memory.seed.estimatedChars" style={FACT_CHIP}>
                  {t("settings.memory.seed.estimatedChars", { chars: payload.chars })}
                </span>
                {/* The exclusion is a CONTROL statement rather than a count, and
                    it is the one number here a user may need to act on, so it
                    keeps its own sentence instead of becoming a fourth chip. */}
                {payload.excludedNotes > 0 ? (
                  <span
                    data-testid="settings.memory.seed.excluded"
                    style={{ ...FACT_CHIP, color: "var(--fg-3)" }}
                  >
                    {t("settings.memory.seed.excluded", { count: payload.excludedNotes })}
                  </span>
                ) : null}
              </p>
              <Button
                variant="ghost"
                data-testid="settings.memory.seed.toggle-payload"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded
                  ? t("settings.memory.seed.hidePayload")
                  : t("settings.memory.seed.showPayload")}
              </Button>
              {expanded ? (
                <pre data-testid="settings.memory.seed.payload" style={PRE}>
                  {payload.payload}
                </pre>
              ) : null}
              {status.remote ? (
                <label
                  data-testid="settings.memory.seed.consent-row"
                  style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-start" }}
                >
                  <input
                    type="checkbox"
                    data-testid="settings.memory.seed.consent"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  <span>
                    {t("settings.memory.seed.consentLabel", {
                      provider: providerName,
                      chars: payload.chars,
                    })}
                  </span>
                </label>
              ) : (
                <p style={HELPER}>{t("settings.memory.seed.localNote")}</p>
              )}
            </>
          ) : null}
          <div style={ACTIONS}>
            <Button variant="ghost" onClick={close} data-testid="settings.memory.seed.cancel">
              {t("settings.memory.seed.cancel")}
            </Button>
            <Button
              data-testid="settings.memory.seed.continue"
              disabled={
                loading ||
                payload === null ||
                status === null ||
                (status.remote && !consent)
              }
              onClick={() => void generate()}
            >
              {t("settings.memory.seed.continue")}
            </Button>
          </div>
        </div>
      ) : step === "candidates" ? (
        <div style={BLOCK} data-testid="settings.memory.seed.candidates">
          {generating ? (
            /* **No card** (issue #970, item 9). The run report used to be a
               bordered `--paper-2` box with a heading, a helper and a
               full-width button inside the modal, a dialog drawn inside a
               dialog, which is what made a 3-line status read as a second thing
               that had appeared on top of the wizard. It is the wizard's own
               state, so it occupies the wizard's own body: a line of text, the
               helper, and a ghost button that hugs its own width instead of
               stretching into a field. */
            <div data-testid="settings.memory.seed.progress" style={PROGRESS_BLOCK}>
              <p style={{ margin: 0 }}>
                {t(progressKey(progress?.phase ?? "working"))}
                {progress !== null && progress.total > 0
                  ? ` (${progress.done}/${progress.total})`
                  : ""}
              </p>
              {progress !== null && progress.total > 0 ? (
                <div
                  style={PROGRESS_TRACK}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.done}
                >
                  <div
                    style={{
                      ...PROGRESS_FILL,
                      width: "100%",
                      transform: `scaleX(${Math.min(1, progress.done / progress.total)})`,
                    }}
                  />
                </div>
              ) : null}
              <p style={HELPER}>{t("settings.memory.seed.generatingHelper")}</p>
              <div style={{ display: "flex" }}>
                <Button
                  variant="ghost"
                  data-testid="settings.memory.seed.cancel-run"
                  onClick={cancelRun}
                >
                  {t("settings.memory.seed.cancelRun")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p style={HELPER}>
                {t("settings.memory.seed.candidatesIntro", { count: candidates.length })}
              </p>
              <ul style={LIST} data-testid="settings.memory.seed.candidate-list">
                {candidates.map((candidate, index) => (
                  <li
                    key={index}
                    style={{ ...CARD, ...(candidate.selected ? null : UNSELECTED_CARD) }}
                    data-testid="settings.memory.seed.candidate"
                    data-selected={candidate.selected ? "true" : "false"}
                  >
                    {/* **The selection control leads the entry and is a real
                        target** (issue #970, item 10). It used to be a native
                        16px checkbox tucked beside the character count ABOVE the
                        text, so the one decision this screen exists for was the
                        smallest thing on it and sat away from the text it
                        decides about. Now the whole header row is the label
                        (clicking the words toggles the entry), the box is
                        `--target-min` square, and the count follows it as the
                        secondary fact it is. */}
                    <label style={CANDIDATE_HEAD}>
                      <input
                        type="checkbox"
                        style={SELECT_BOX}
                        data-testid={`settings.memory.seed.candidate-select-${index}`}
                        checked={candidate.selected}
                        onChange={(e) =>
                          setCandidates((prev) =>
                            prev.map((c, i) =>
                              i === index ? { ...c, selected: e.target.checked } : c,
                            ),
                          )
                        }
                      />
                      <span style={{ ...HELPER, cursor: "pointer" }}>
                        {t("settings.memory.seed.charCount", {
                          count: candidate.text.length,
                        })}
                      </span>
                    </label>
                    {/* The textarea grows with its own content, because a fixed
                        `rows={3}` cut the entry off mid-sentence: the first
                        candidate in the report ended on "Subfolders split by
                        project." with the rest of the line clipped, and a review
                        screen that hides the words it is asking you to approve
                        is asking you to approve something you did not read. It
                        stops growing at `MAX_ROWS` and scrolls past that, so one
                        long entry cannot push the Save button off the modal. */}
                    <Textarea
                      data-testid={`settings.memory.seed.candidate-text-${index}`}
                      aria-label={t("settings.memory.seed.candidateLabel", { index: index + 1 })}
                      value={candidate.text}
                      rows={candidateRows(candidate.text)}
                      spellCheck={false}
                      disabled={applying}
                      invalid={candidate.refusal !== undefined}
                      onChange={(e) =>
                        setCandidates((prev) =>
                          prev.map((c, i) =>
                            i === index
                              ? { ...c, text: e.target.value, refusal: undefined }
                              : c,
                          ),
                        )
                      }
                    />
                    {candidate.refusal !== undefined ? (
                      <p
                        data-testid={`settings.memory.seed.candidate-refusal-${index}`}
                        style={{ ...HELPER, color: "var(--danger)" }}
                      >
                        {t(`settings.memory.seed.refusals.${candidate.refusal}`)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
              {runError !== null ? (
                <p data-testid="settings.memory.seed.apply-error" style={{ ...HELPER, color: "var(--danger)" }}>
                  {capDetail !== null
                    ? t("settings.memory.seed.errors.capDetail", {
                        remaining: capDetail.remaining,
                        requested: capDetail.requested,
                      })
                    : t(runError)}
                </p>
              ) : null}
              <div style={ACTIONS}>
                <Button
                  variant="ghost"
                  data-testid="settings.memory.seed.back"
                  disabled={applying}
                  onClick={() => {
                    setRunError(null);
                    setCapDetail(null);
                    setStep("scope");
                  }}
                >
                  {t("settings.memory.seed.back")}
                </Button>
                <Button
                  data-testid="settings.memory.seed.apply"
                  disabled={
                    applying ||
                    candidates.every((c) => !c.selected || c.text.trim().length === 0)
                  }
                  onClick={() => void apply()}
                >
                  {applying
                    ? t("settings.memory.seed.applying")
                    : t("settings.memory.seed.apply", {
                        count: candidates.filter((c) => c.selected).length,
                      })}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </ModalShell>
  );
}

/** The Settings > AI > Memory row that opens the wizard. */
export function SeedMemoryRow(props: {
  onShowToast: (message: string) => void;
  /** Ask the enclosing Memory panel to re-read its list. Without it the panel
   *  keeps the pre-seed roster while the group appears one full mount later. */
  onApplied?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SeedStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const sidebar = useSelectedNoteOptional();

  const reload = useCallback(async () => {
    try {
      setStatus(await seedMemoryStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const seeded = status !== null && status.seedEntries > 0;
  const created = status?.seededAt != null ? new Date(status.seededAt).toLocaleDateString() : null;
  const stale = isSeedStale(
    status?.seededAt ?? null,
    sidebar === null ? [] : Array.from(sidebar.cache.values()),
  );

  return (
    <div
      style={CARD}
      data-testid="settings.memory.seed-row"
      data-setting-anchor="ai.memorySeed"
      data-seeded={seeded ? "true" : "false"}
    >
      <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>
        {t("settings.memory.seed.title")}
      </p>
      <p style={HELPER}>
        {seeded
          ? t("settings.memory.seed.rowSeeded", {
              date: created ?? "",
              count: status.seedEntries,
            })
          : t("settings.memory.seed.rowHelper")}
      </p>
      {seeded && stale ? (
        <p data-testid="settings.memory.seed.stale" style={HELPER}>
          {t("settings.memory.seed.rowStale")}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        {confirming ? (
          <>
            <Button
              data-testid="settings.memory.seed.rebuild-confirm"
              onClick={() => {
                setConfirming(false);
                setOpen(true);
              }}
            >
              {t("settings.memory.seed.rebuildConfirm", {
                date: created ?? "",
                count: status?.seedEntries ?? 0,
              })}
            </Button>
            <Button
              variant="ghost"
              data-testid="settings.memory.seed.rebuild-cancel"
              onClick={() => setConfirming(false)}
            >
              {t("settings.memory.seed.cancel")}
            </Button>
          </>
        ) : (
          <Button
            variant={seeded ? "secondary" : "primary"}
            data-testid="settings.memory.seed.open"
            onClick={() => {
              if (seeded) setConfirming(true);
              else setOpen(true);
            }}
          >
            {seeded
              ? t("settings.memory.seed.rebuild")
              : t("settings.memory.seed.title")}
          </Button>
        )}
      </div>
      <SeedMemoryWizard
        open={open}
        onClose={() => {
          setOpen(false);
          void reload();
        }}
        onApplied={() => {
          void reload();
          props.onApplied?.();
        }}
      />
    </div>
  );
}
