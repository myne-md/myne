// The one reader of the local-inference `EngineError` wire shape.
//
// Every on-device AI seam rejects with the same closed Rust enum, serialized by
// Tauri as either a bare variant string (`"NotReady"`) or a `{ kind }` object
// depending on the variant's payload. Each seam then narrows that to the kinds
// IT cares about — `transcribe.ts` only needs "not ready vs failed", `ai-tags.ts`
// also needs "deferred" — but the extraction is identical, and a copy of it in
// every seam is a copy that silently reports `failed` when a new variant lands.
//
// Content-free by construction: the variant tag is a fixed identifier, never the
// prompt, the note body, or the model's output. Keep it that way.

/**
 * The `EngineError` variant tag of a raw IPC rejection, or `""` when the value
 * is not one (an unrecognized shape must not be mistaken for a known kind). Pure.
 */
export function engineErrorTag(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw !== null && typeof raw === "object" && "kind" in raw) {
    return String((raw as { kind: unknown }).kind);
  }
  return "";
}

/**
 * The provider-facing causes a user can actually act on (ai-remote-providers
 * task 7). Five, because the issue's "three distinct states, not one" leaves
 * out the two the tree could not otherwise express:
 *
 * | cause | what happened | what the user does |
 * |---|---|---|
 * | `no_credential` | nothing is stored | paste a key |
 * | `unauthorized` | the provider declined it | replace the key |
 * | `quota_exhausted` | out of credit or rate-limited | fix it at the provider |
 * | `unreachable` / `refused` | nothing answered / it said no | check the service |
 * | `timeout` | no answer in time | retry |
 *
 * `no_credential` and `unauthorized` are separate on purpose: collapsing them
 * shows "check your API key" to someone who has never entered one.
 *
 * Four more landed with myne-md/myne#466, all of them previously invisible —
 * their Rust variants were simply absent from the table below and fell into the
 * `"failed"` catch-all, so four different situations rendered one sentence, and
 * that sentence ("nothing was sent again") was flatly untrue for the first of
 * them:
 *
 * | cause | what happened | what the user does |
 * |---|---|---|
 * | `policy_refused` | the provider claimed success and declined under its own rules | fix it at the provider |
 * | `empty_completion` | the model answered with nothing | rephrase |
 * | `local_model_missing` | a recorded local model file is gone; nothing was sent | pick a model again |
 * | `not_ready` | nothing is set up to answer yet; nothing was sent | pick a model, or name a provider |
 */
export type ProviderErrorCause =
  | "no_credential"
  | "unauthorized"
  | "quota_exhausted"
  | "policy_refused"
  | "unreachable"
  | "refused"
  | "timeout"
  | "barred"
  | "empty_completion"
  | "local_model_missing"
  | "not_ready"
  | "failed";

/** Both spellings, because Tauri serializes a unit variant as its identifier
 *  and the `kind()` helper emits snake_case — a seam that maps only one of
 *  them silently reports the catch-all for the other. */
const PROVIDER_CAUSE_BY_TAG: Readonly<Record<string, ProviderErrorCause>> = {
  NoCredential: "no_credential",
  no_credential: "no_credential",
  Unauthorized: "unauthorized",
  unauthorized: "unauthorized",
  QuotaExhausted: "quota_exhausted",
  quota_exhausted: "quota_exhausted",
  PolicyRefused: "policy_refused",
  policy_refused: "policy_refused",
  Unreachable: "unreachable",
  unreachable: "unreachable",
  Refused: "refused",
  refused: "refused",
  Timeout: "timeout",
  timeout: "timeout",
  RemoteBarred: "barred",
  remote_barred: "barred",
  EmptyCompletion: "empty_completion",
  empty_completion: "empty_completion",
  LocalModelMissing: "local_model_missing",
  local_model_missing: "local_model_missing",
  NotReady: "not_ready",
  not_ready: "not_ready",
};

/**
 * Narrow a raw IPC rejection to a provider cause. Anything unrecognized —
 * including a variant a newer host knows and this build does not — falls back
 * to `"failed"` rather than throwing, because a settings surface that crashes
 * on an unknown error is strictly worse than one that says "it did not work".
 */
export function normalizeProviderError(raw: unknown): ProviderErrorCause {
  return PROVIDER_CAUSE_BY_TAG[engineErrorTag(raw)] ?? "failed";
}

/** The i18n key for a cause. A total function over the union, so a new cause
 *  fails to compile here rather than rendering an empty string. */
export function providerErrorKey(cause: ProviderErrorCause): string {
  switch (cause) {
    case "no_credential":
      return "settings.ai.providerError.noCredential";
    case "unauthorized":
      return "settings.ai.providerError.unauthorized";
    case "quota_exhausted":
      return "settings.ai.providerError.quotaExhausted";
    case "policy_refused":
      return "settings.ai.providerError.policyRefused";
    case "empty_completion":
      // The one cause whose key lives outside this block, deliberately
      // (myne-md/myne#466). "No answer — try rephrasing" already exists and
      // already says exactly the right thing for an empty completion; writing a
      // second sentence with the same meaning under `providerError.*` would
      // give translators two strings to keep in step for one situation.
      // `AiChatTab` renders this cause through the placeholder that owns that
      // key rather than through the error paragraph — an empty answer is a
      // result, not a fault.
      return "editor.chrome.rightPanel.aiChat.noAnswer";
    case "local_model_missing":
      return "settings.ai.providerError.localModelMissing";
    case "not_ready":
      return "settings.ai.providerError.notReady";
    case "unreachable":
      return "settings.ai.providerError.unreachable";
    case "refused":
      return "settings.ai.providerError.refused";
    case "timeout":
      return "settings.ai.providerError.timeout";
    case "barred":
      return "settings.ai.providerError.barred";
    case "failed":
      return "settings.ai.providerError.failed";
  }
}
