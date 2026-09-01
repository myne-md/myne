import { providerLabelOf } from "@myne/copy";
import { invoke } from "../platform/core";
import type { AnsweredBy } from "../components/AnsweredByIndicator";

// The one AI capability report (ai-provider-seam task 8, sync-ledger SYNC-5).
//
// Why a runtime report next to a build-time capability, rather than either
// alone: `src/platform/capabilities.ts`'s `localAi` answers "can this platform
// ever" and must stay a build-time constant (the descriptor is not allowed to
// be an `await`). This answers "can it right now", which is a different
// question the moment a backend can be present-but-unreachable. The in-tree
// precedent is quick-unlock — a static capability plus `quick_unlock_status`.
//
// Why host-side: the WebView's CSP `connect-src` cannot reach a loopback
// daemon, so a browser-side probe would be answering a question it
// structurally cannot answer.

/** A cause from the Rust `EngineError` taxonomy (`error.rs`), never a
 *  report-only vocabulary — a second set of strings would be a second thing to
 *  keep in step. `null` when the feature is available. */
export type AiFeatureCause = string | null;

export interface AiFeatureStatus {
  available: boolean;
  cause: AiFeatureCause;
}

export interface AiCapabilityReport {
  /** `false` when the AI feature was not compiled into this build at all.
   *
   *  This is the fact `src/platform/capabilities.ts` structurally cannot see:
   *  `localAi` is hardcoded `true` for desktop and nothing on this side can
   *  observe a cargo feature. A `--no-default-features` build therefore renders
   *  the whole AI UI today and fails at invoke time. Exposing it here is this
   *  task's job; **consuming** it to fix that honesty gap is #191's. */
  compiled: boolean;
  /** Stable id of the active backend, or `null` when nothing is compiled. */
  backendId: string | null;
  /** `in_process_local` | `loopback_local` | `remote`, or `null`. */
  backendClass: string | null;
  generation: AiFeatureStatus;
  embedding: AiFeatureStatus;
  transcription: AiFeatureStatus;
  autoTag: AiFeatureStatus;
  /** Whether the vault's embedding index is BUILT, as distinct from whether an
   *  embedding model exists at all (myne-md/myne#545).
   *
   *  `embedding` says asking can run; this says it can run now. The chat header
   *  needs both, or "still indexing" and "ready" look identical and it shows
   *  the provider's name — which reads as ready — for a surface that will
   *  refuse every turn. */
  indexReady: boolean;
}

const UNCOMPILED_FEATURE: AiFeatureStatus = { available: false, cause: null };

/** The report for a build with no AI compiled in. Every feature unavailable,
 *  and `cause: null` rather than a made-up cause — nothing refused the request;
 *  there was nothing to refuse it. */
export const UNCOMPILED_REPORT: AiCapabilityReport = {
  compiled: false,
  backendId: null,
  backendClass: null,
  generation: UNCOMPILED_FEATURE,
  embedding: UNCOMPILED_FEATURE,
  transcription: UNCOMPILED_FEATURE,
  autoTag: UNCOMPILED_FEATURE,
  indexReady: false,
};

interface WireFeature {
  available?: unknown;
  cause?: unknown;
}

function feature(raw: unknown): AiFeatureStatus {
  const f = (raw ?? {}) as WireFeature;
  return {
    available: f.available === true,
    cause: typeof f.cause === "string" ? f.cause : null,
  };
}

/**
 * Ask the host what the AI surface can do right now.
 *
 * **A rejection is an answer, not an error.** When the plugin is not compiled
 * the command does not exist and the invoke is rejected — that is exactly how
 * this side learns `compiled: false`, and it is why this function does not
 * throw. It is the one place that conflation is correct, because there is
 * genuinely nothing else a missing command can mean here; every *other* reason
 * a feature is unavailable arrives as a named cause inside the report.
 */
export async function aiCapabilityReport(): Promise<AiCapabilityReport> {
  try {
    const raw = await invoke<Record<string, unknown>>(
      "plugin:local-inference|ai_capability_report",
    );
    return {
      compiled: raw.compiled === true,
      backendId: typeof raw.backend_id === "string" ? raw.backend_id : null,
      backendClass:
        typeof raw.backend_class === "string" ? raw.backend_class : null,
      generation: feature(raw.generation),
      embedding: feature(raw.embedding),
      transcription: feature(raw.transcription),
      autoTag: feature(raw.auto_tag),
      indexReady: raw.index_ready === true,
    };
  } catch {
    return UNCOMPILED_REPORT;
  }
}

/**
 * Which backend answered, derived from the report the host already sends
 * (ai-remote-providers myne#415 task 15).
 *
 * **The datum travels through the existing seam rather than a new one.** The
 * capability report already carries `backendId` + `backendClass` per answer's
 * backend; adding a parallel channel for "who answered" would be a second
 * thing to keep in step with the first.
 *
 * `providerLabel` is supplied by the caller because the host stores a wire
 * name (`openrouter`) and the user reads a proper noun (`OpenRouter`) — the
 * mapping is a UI fact and does not belong in the report.
 *
 * Falls back to `in-process` for an unknown class rather than throwing: an
 * indicator that crashes a chat turn because a newer host used a class this
 * build does not know is worse than one that under-states.
 */
/**
 * The attribution a RESPONSE reported, as the indicator renders it
 * (myne-md/myne#440).
 *
 * Distinct from {@link answeredByOf}, which derives the same shape from the
 * current capability report — right for a live status chip, wrong for a turn
 * that has already been answered. The name comes from the host too: deriving it
 * frontend-side from the remote provider's wire value made a loopback answer
 * render "Answered by " with nothing after it, because a loopback answer has no
 * remote provider.
 */
export function answeredByFromResponse(served: {
  class: string;
  name: string | null;
}): AnsweredBy {
  switch (served.class) {
    case "remote":
      return { kind: "remote", provider: providerLabelOf(served.name) ?? "" };
    case "loopback_local":
      return { kind: "local-runtime", name: served.name ?? "" };
    default:
      return { kind: "in-process" };
  }
}

export function answeredByOf(
  report: Pick<AiCapabilityReport, "backendClass">,
  providerLabel?: string,
): AnsweredBy {
  switch (report.backendClass) {
    case "remote":
      return { kind: "remote", provider: providerLabel ?? "" };
    case "loopback_local":
      return { kind: "local-runtime", name: providerLabel ?? "" };
    default:
      return { kind: "in-process" };
  }
}

/**
 * Which AI feature a surface is asking about. The names are the report's own,
 * so there is no second vocabulary to keep in step (#191 task 1).
 */
export type AiFeature = "generation" | "embedding" | "transcription" | "autoTag";

/**
 * What a surface should say about a feature, as a closed set of states.
 *
 * **Four states, deliberately, where the tree previously had one bit.** Five
 * independent `catch → false` sites used to collapse "this build has no AI",
 * "you have not chosen a model", "the backend refused" and "the command does
 * not exist" into a single `false`, and `ai-tags.ts` even documented the
 * collapse as intentional. That collapse is exactly what makes an empty state
 * lie: the user is told to pick a model when the real answer is that their
 * runtime is not answering, or that this build has no AI at all.
 *
 * - `checking` — the one host read is in flight. Not an answer; render nothing
 *   definitive.
 * - `absent` — the feature is not compiled into this build. The invoke is
 *   rejected because the command does not exist, and no user action fixes it.
 * - `available` — it will run.
 * - `unavailable` — it exists and will not run right now, with the host's own
 *   `EngineError` cause. `cause` is `null` only when the host offered none.
 */
export type AiSurfaceState =
  | { kind: "checking" }
  | { kind: "absent" }
  | { kind: "available" }
  | { kind: "unavailable"; cause: AiFeatureCause };

/**
 * Narrow a report to one feature's state.
 *
 * The one place the report becomes a surface-level answer, mirroring how
 * `src/lib/transcribe.ts` narrows `EngineError` for the transcribe path. A
 * second narrower would be a second thing to keep in step with the taxonomy,
 * which is the failure this task exists to remove.
 *
 * **A note on what this cannot tell you.** "A provider is named but is not
 * answering" is not a state the report can report at rest: knowing it would
 * mean reaching the provider, and a settings panel that connects because it
 * was opened is a byte leaving on nobody's instruction. It arrives instead as
 * a *request-time* cause — `unreachable`, `timeout`, `unauthorized`,
 * `quota_exhausted` — through the same `EngineError` vocabulary, which is why
 * this type carries the host's cause rather than a boolean.
 */
export function surfaceStateOf(
  report: AiCapabilityReport,
  feature: AiFeature,
): AiSurfaceState {
  if (!report.compiled) return { kind: "absent" };
  const status = report[feature];
  return status.available
    ? { kind: "available" }
    : { kind: "unavailable", cause: status.cause };
}

// `providerLabelOf` moved to `@myne/copy` (myne-md/myne#456), and it is still
// re-exported from here because `answeredByOf`'s whole contract is that the
// caller supplies this: so this file stays the one place a reader looks for
// "how do I name the active arm".
//
// It moved because it is a table of PROPER NOUNS, which is precisely the class
// that package exists for: a brand name reads identically in every locale, and
// a third client now needs it. One table, three consumers.
export { providerLabelOf } from "@myne/copy";
