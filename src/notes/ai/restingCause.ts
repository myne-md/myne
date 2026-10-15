// One reading of the chat surface's resting cause (myne-md/myne#867).
//
// ── The defect this closes ─────────────────────────────────────────────────
// Three switches bucketed the host's cause into four arms. The host names an
// `EngineError` kind precisely (`FeatureOff`, `NotReady`, `NoCredential`,
// `ConsentMissing`, `NoModel`, ...), and everything the bucket did not
// recognise rendered as `no-provider`, so a vault with a provider named and a
// model chosen but no consent recorded said "No provider": the surface
// contradicting the settings the user had just made, and naming an action they
// had already performed.
//
// ── Why one module for three renderers ─────────────────────────────────────
// The header chip, that chip's tooltip and the transcript's empty state are
// three renderings of ONE value. They were three switches that agreed by hand,
// which is the shape that drifts: the transcript could explain a fault the chip
// had named differently, and nothing could see it.
//
// ── Two of the ids are not causes ──────────────────────────────────────────
// `off` is the user's own switch, and `unavailable` is a build with no AI
// compiled in. Neither is an `EngineError`, and both keep their own copy.
// Everything else IS a `ProviderErrorCause`, normalized here by the same
// function the transcript already uses for a failed turn, so a new host cause
// reaches the chip through a table the compiler holds complete rather than
// through a default arm that quietly says the wrong thing.
//
// ── The keys are dynamic, so a test is the binding ─────────────────────────
// `t(CHIP_KEY[id])` and `t(providerErrorKey(id))` are not static call sites, so
// `scripts/check-i18n.mjs` cannot see them by construction. The keys they can
// return are held to their catalog entries by `tests/lib/providerError.test.ts`,
// the same way `providerErrorKey`'s already are.

import {
  normalizeProviderError,
  providerErrorKey,
  type ProviderErrorCause,
} from "../../lib/engine-error";

export type TFn = (key: string, opts?: Record<string, unknown>) => string;

/**
 * What the chat surface is resting on. Either one of the two states that are
 * not host causes, or the host's own cause.
 */
export type RestingId = "off" | "unavailable" | "ready" | ProviderErrorCause;

/**
 * **A chip label per cause, and the table is exhaustive on purpose.**
 *
 * A chip is one or two words: a sentence in it would be unreadable, which is why
 * this is not `providerErrorKey`. Several causes share a label because they are
 * the same fact from the reader's side (three transport failures are all "Not
 * answering"; a missing local file and a provider with no model chosen are both
 * "No model"), and sharing one is honest where inventing two would not be.
 */
export const CHIP_KEY: Readonly<Record<ProviderErrorCause, string>> = {
  // The user's own switch, reached from the report rather than from the pref.
  feature_off: "editor.chrome.rightPanel.aiChat.statusOff",
  // Nothing is named at all. The one case where "No provider" is the truth.
  not_ready: "editor.chrome.rightPanel.aiChat.statusNoModel",
  // No model to run: no local file, or a named provider with none chosen.
  no_model: "editor.chrome.rightPanel.aiChat.statusNoModelChosen",
  local_model_missing: "editor.chrome.rightPanel.aiChat.statusNoModelChosen",
  no_credential: "editor.chrome.rightPanel.aiChat.statusNoCredential",
  consent_missing: "editor.chrome.rightPanel.aiChat.statusConsentMissing",
  // This device's own controls, or the request class the gate bars outright.
  barred: "editor.chrome.rightPanel.aiChat.statusNotAllowed",
  empty_grant: "editor.chrome.rightPanel.aiChat.statusNotAllowed",
  // Nothing answered, or the answer was not usable.
  unreachable: "editor.chrome.rightPanel.aiChat.statusUnreachable",
  refused: "editor.chrome.rightPanel.aiChat.statusUnreachable",
  timeout: "editor.chrome.rightPanel.aiChat.statusUnreachable",
  // The provider's own decisions, and the user's account at it.
  unauthorized: "editor.chrome.rightPanel.aiChat.statusKeyRejected",
  quota_exhausted: "editor.chrome.rightPanel.aiChat.statusOutOfCredit",
  policy_refused: "editor.chrome.rightPanel.aiChat.statusRefused",
  request_rejected: "editor.chrome.rightPanel.aiChat.statusRefused",
  empty_completion: "editor.chrome.rightPanel.aiChat.statusRefused",
  // The catch-all, for a cause this build does not know.
  failed: "editor.chrome.rightPanel.aiChat.statusNotWorking",
};

/** The chip's label. */
export function restingLabel(id: RestingId, t: TFn): string {
  switch (id) {
    case "off":
      return t("editor.chrome.rightPanel.aiChat.statusOff");
    case "unavailable":
      return t("editor.chrome.rightPanel.aiChat.statusUnavailable");
    case "ready":
      return t("editor.chrome.rightPanel.aiChat.statusReady");
    default:
      return t(CHIP_KEY[id]);
  }
}

/**
 * The sentence that explains the id, for the chip's tooltip and for the empty
 * transcript's body. The SAME sentence in both, which is the point: a user who
 * reads the chip and then the transcript is reading one statement twice, not
 * two statements that have to be kept in step.
 */
export function restingBody(id: RestingId, t: TFn): string {
  switch (id) {
    case "off":
      return t("editor.chrome.rightPanel.aiChat.offHint");
    case "unavailable":
      return t("editor.chrome.rightPanel.aiChat.unavailableHint");
    case "ready":
      return t("editor.chrome.rightPanel.aiChat.empty");
    default:
      return t(providerErrorKey(id));
  }
}

/**
 * Whether the surface is in a fault state rather than merely resting.
 *
 * `off` is not a fault, it is a preference, and the transcript's ordinary empty
 * state is the right thing under it. Everything else that is not `ready` is a
 * fault the user may be able to clear: `unavailable` because a build cannot
 * change, the causes because they can.
 */
export function restingIsDegraded(id: RestingId): boolean {
  return id !== "off" && id !== "ready";
}

/** The host's raw cause, as the report spells it, reduced to a {@link RestingId}.
 *
 *  An unrecognised string is the catch-all's business rather than a throw: a
 *  host newer than this build may name a cause the table has never heard of, and
 *  a surface that lies about which fault it has is worse than one that says it
 *  does not know (which is what `providerError.failed` exists for). */
export function restingIdOf(cause: string | null): ProviderErrorCause {
  return normalizeProviderError(cause);
}
