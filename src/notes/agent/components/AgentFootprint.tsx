// The run's footprint is an ENTRY IN THE TRANSCRIPT, not a strip beside it
// (myne-md/myne#848).
//
// ── What was wrong with the strip ───────────────────────────────────────────
// A finished run reported its outcome in a band pinned under the transcript,
// outside the scrolling region, tied to the run rather than to the turn. Three
// consequences, and the third is the one that made this a task:
//
//   1. the band and the turn said the same thing in two places, and only the
//      band had the numbers, so the transcript's own record of a run read as a
//      summary of a summary;
//   2. scrolling back through a conversation showed turns with no footprint,
//      because the footprint was not in the conversation;
//   3. "New chat" deletes the transcript and NOT the run, so the band outlived
//      the turn it described and reported a run whose conversation the user had
//      just walked away from.
//
// ── One line, and the disclosure carries the rest ───────────────────────────
// The line is the whole resting state: what happened, and how long it took. The
// numbers behind it are the compensating control `design-notes/ai/0515` names
// for the remote arm having no volume bound, so they are one click away rather
// than always on screen or absent, and the disclosure is a real `<button>`
// with `aria-expanded`, not a hover affordance, because the figures have to be
// reachable by keyboard and on a phone.
//
// ── What the host does and does not report ─────────────────────────────────
// `memoryUpdated` is a COUNT (0 or 1 per settled step, summed across resumes),
// so a memory write renders as one chip carrying that count rather than as one
// chip per entry, the per-entry detail does not cross IPC. A failed TOOL CALL
// is not reported at all: `AgentStepResult` has no per-call error list, so what
// this file renders on its own line is the run's own failure (`agentStore`'s
// `error`), which is the failure the user can act on. The missing half is
// recorded in the feature's task list rather than papered over here.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { StatusMark } from "../../../components/Spinner";
import { IconButton } from "../../../components/primitives/IconButton";
import { RunCostLine } from "./RunCostLine";

const LINE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "var(--space-1)",
  color: "var(--fg-3)",
  fontSize: "var(--text-xs)",
};

const DETAIL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  paddingTop: "var(--space-1)",
  color: "var(--fg-3)",
  fontSize: "var(--text-xs)",
};

const CHIP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "0 var(--space-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  color: "var(--fg-2)",
};

/**
 * A duration the way a person reads one: one unit, one decimal.
 *
 * Deliberately lossy above a minute. "2m 14s" invites arithmetic the reader did
 * not ask for; "2m" answers the only question the figure is there for ("was that
 * a nuisance?"). Sub-second runs report `1s` rather than `0.4s`, because the
 * clock this comes from is wall time and cannot support the precision.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

export interface AgentFootprintFigures {
  /** Model round-trips. */
  iterations: number;
  /** Notes read in full. */
  notesRead: number;
  /** Characters that left the device, or `null` when the run stayed local. */
  charsOffDevice: number | null;
  /** Memory entries written, 0 or more. */
  memoryUpdated: number;
}

/**
 * Elapsed milliseconds since `since`, re-rendering once a second while
 * `ticking`. `null` when there is nothing to measure.
 *
 * The ticker lives here rather than in the store because a clock is a view
 * concern: a store that re-rendered every subscriber once a second would wake
 * the transcript, the composer and the hub for a number only this line shows.
 */
export function useElapsedMillis(since: number | null, ticking: boolean): number | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!ticking || since === null) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [ticking, since]);
  return since === null ? null : Math.max(0, Date.now() - since);
}

export interface AgentFootprintProps {
  /** How the run ended, already localized, or `null` while it is still working. */
  settledLabel: string | null;
  /** The settled duration, or `null` when it cannot be known. */
  durationMillis: number | null;
  /** When the run started, for the ticking duration of a run still in flight. */
  startedAtMillis?: number | null;
  figures: AgentFootprintFigures;
  /** The run's scope and how it grew, when the caller knows. */
  scopeTotal?: number;
  userGrants?: number;
  modelGrants?: number;
  /** The run's own failure message, already localized. */
  error?: string | null;
  /** Whether the run failed, for the line's icon. */
  failed?: boolean;
}

export function AgentFootprint({
  settledLabel,
  durationMillis,
  startedAtMillis = null,
  figures,
  scopeTotal,
  userGrants,
  modelGrants,
  error,
  failed = false,
}: AgentFootprintProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const status = settledLabel ?? t("agent.progress.working");
  // While the run is in flight the settled figure does not exist yet, so the
  // line measures from the run's start instead of showing nothing.
  const working = settledLabel === null;
  const elapsed = useElapsedMillis(working ? startedAtMillis : null, true);
  const shown = durationMillis ?? elapsed;

  return (
    <div data-testid="agentFootprint" data-settled={settledLabel !== null}>
      <div style={LINE_STYLE}>
        <span style={{ display: "inline-flex" }}>
          {/* **The status mark, and it SPINS while the run works**
              (myne-md/myne#894, second pass: "the working thing does not turn").
              `StatusMark` is the repo's own inline status mark, a named icon at
              12px, wrapped in `.myne-spinner` when `spinning`, so the rotation
              and its MYND-630 reduced-motion carve-out (half speed rather than
              frozen, because a spinner stopped mid-turn reads as hung) come from
              the primitive rather than from a private keyframe here.

              The wave is on the LABEL only now: two motions on one 12px mark
              fight each other, and of the two, the turn is the one that says
              "work is happening". The glyph stays non-rotating once the run has
              settled (`check` / `circle-alert`), which is the same state-not-shape
              rule the primitive states.

              `label={null}` because the sentence beside it already says the
              state aloud. */}
          <StatusMark
            name={working ? "loader-circle" : failed ? "circle-alert" : "check"}
            label={null}
            spinning={working}
            tone={working ? "accent" : "muted"}
            testId="agentFootprint.mark"
          />
        </span>
        <span
          data-testid="agentFootprint.status"
          style={{ color: "var(--fg-2)" }}
          className={working ? "myne-working-wave" : undefined}
          data-motion={working ? "essential" : undefined}
        >
          {status}
        </span>
        {shown !== null ? (
          <>
            <span aria-hidden="true">&middot;</span>
            <span data-testid="agentFootprint.duration">{formatDuration(shown)}</span>
          </>
        ) : null}
        {/* **While the run works, its figures are ON the line.**
            `design-notes/ai/0515` and the threat-model bullet both say the
            running scope total is shown continuously, and the strip this
            replaced said in as many words that it "does not belong behind a
            disclosure". Only the SETTLED detail goes behind the disclosure, which
            is what the acceptance asks for: a finished run's line is one line,
            and a working run's numbers are readable without a press. */}
        {working ? (
          <>
            {scopeTotal !== undefined ? (
              <span data-testid="agentFootprint.scope">
                {t("agent.progress.scopeTotal", { count: scopeTotal })}
              </span>
            ) : null}
            <RunCostLine
              testId="agentFootprint.runCost"
              iterations={figures.iterations}
              notesRead={figures.notesRead}
              charsOffDevice={figures.charsOffDevice}
            />
          </>
        ) : (
          /* **The disclosure exists only once the run has settled.** While it
             works there is nothing behind it (the figures are on the line), and
             rendering both put the same cost line on screen twice: once inline
             and once in the detail. */
          <IconButton
            icon={open ? "chevron-up" : "chevron-down"}
            iconSize={12}
            label={t("agent.footprint.disclosure")}
            tooltip
            expanded={open}
            testId="agentFootprint.disclosure"
            onClick={() => setOpen((v) => !v)}
          />
        )}
      </div>

      {open && !working ? (
        <div data-testid="agentFootprint.detail" style={DETAIL_STYLE}>
          {/* The three figures `design-notes/ai/0515` requires, through the ONE
              component that words them, so the footprint and the review screen
              cannot disagree about a number that is a privacy disclosure. */}
          <RunCostLine
            testId="agentFootprint.runCost"
            iterations={figures.iterations}
            notesRead={figures.notesRead}
            charsOffDevice={figures.charsOffDevice}
          />
          {scopeTotal !== undefined ? (
            <span data-testid="agentFootprint.scope">
              {t("agent.progress.scopeTotal", { count: scopeTotal })}
              {userGrants !== undefined && modelGrants !== undefined ? (
                <>
                  {" ("}
                  {t("agent.progress.grantsUser", { count: userGrants })}
                  {", "}
                  {t("agent.progress.grantsModel", { count: modelGrants })}
                  {")"}
                </>
              ) : null}
            </span>
          ) : null}
          {figures.memoryUpdated > 0 ? (
            <span data-testid="agentFootprint.memory">
              <span style={CHIP_STYLE}>
                {t("agent.footprint.memory", { count: figures.memoryUpdated })}
              </span>
            </span>
          ) : null}
          {error !== null && error !== undefined && error !== "" ? (
            <span data-testid="agentFootprint.error" style={{ color: "var(--danger)" }}>
              {error}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
