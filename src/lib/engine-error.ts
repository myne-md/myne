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
 *
 * And one more with myne-md/myne#456, for the same reason those four landed:
 * its Rust variant was absent from the table and fell into the catch-all.
 *
 * | cause | what happened | what the user does |
 * |---|---|---|
 * | `feature_off` | the AI opt-in is off; nothing was sent | turn it on |
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
  /** Asking cannot run: no on-device embedding model is selected, and a remote
   *  provider cannot supply one (SYNC-16). Split out of `not_ready` because
   *  that sentence sends the user to name a provider, which is exactly what
   *  they have already done (myne-md/myne#545). */
  | "no_embedding_model"
  /** An embedding model is selected and the vault's index is still being
   *  built. A state, not a failure: the next move is to wait. */
  | "index_not_ready"
  /** The provider rejected the REQUEST (HTTP 400), rather than the credential
   *  or the cost. Split out because the fix is on Myne's side, not the
   *  user's, and because collapsed into the generic failure it reached the
   *  user as a note that could not be read (myne-md/myne#547). */
  | "request_rejected"
  /** The AI opt-in is off. Nothing was sent, nothing is wrong, and the fix is
   *  one switch (myne-md/myne#456).
   *
   *  **Added because it was reachable and collapsed.**
   *  `core/src/inference/provider_gate.rs` checks `ai_enabled` FIRST and
   *  returns `EngineError::FeatureOff`, so this is the first of the gate's four
   *  refusals, not a hypothetical one. `feature_off` was absent from the table
   *  below, so it fell into `"failed"` and the user was told "it did not work"
   *  about a preference they had switched off themselves. The reason it went
   *  unnoticed on desktop is that the AI panel is where you would already be;
   *  on a phone the agent tab can be open when the pref flips, and the run then
   *  fails with a sentence naming no fix. */
  | "feature_off"
  /** No consent has been recorded ON THIS DEVICE for the selected provider.
   *  Nothing was sent; the fix is to accept the consent screen once, here.
   *
   *  **Split out of `barred` by myne-md/myne#456, and the split is the point.**
   *  One Rust variant used to carry two unrelated meanings: a rule about a
   *  request CLASS that no user choice can lift (an ambient request, or any
   *  embedding, may never use a remote backend) and a permission the user has
   *  simply not given yet. Collapsed, someone who had never seen the consent
   *  screen was told "this kind of request never goes to a provider", which is
   *  false about their request and silent about the one action that fixes it.
   *
   *  Distinct from `no_credential` for the same class of reason: one means
   *  there is nothing to send, the other that you have not agreed to send it,
   *  and the fixes are in different places. */
  | "consent_missing"
  | "failed";

/**
 * A serialized `EngineError` tag, in either spelling, reduced to one.
 *
 * Tauri serializes a unit variant as its identifier (`NoCredential`) while the
 * `kind()` helper emits snake_case (`no_credential`), so both reach every seam
 * that reads one, and a table mapping only one of them silently reports its
 * catch-all for the other. Normalizing first is what lets a table hold one row
 * per cause instead of two.
 *
 * Exported, so `normalizeTranscribeError` uses this rather than a second copy;
 * the rationale for each table's own shape lives with that table.
 */
export function snakeCase(tag: string): string {
  return tag.replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase();
}

// A `Map`, not an object literal: an object's lookup walks `Object.prototype`,
// so a tag of `constructor`, `toString` or `hasOwnProperty` would resolve to a
// truthy function and be returned as a cause, and the key lookup below would
// then render nothing where an error sentence belongs. Not reachable from the
// closed Rust enum, and one word to close.
// Only the causes whose name is NOT the normalized tag; today exactly one,
// `RemoteBarred`, which is the only row a reader has any reason to look at.
// Writing both spellings by hand instead was 22 entries for 11 causes, and
// adding a cause meant remembering to add two.
const PROVIDER_CAUSE_RENAMES = new Map<string, ProviderErrorCause>([["remote_barred", "barred"]]);

const PROVIDER_CAUSES: ReadonlySet<string> = new Set<ProviderErrorCause>([
  "no_credential",
  "unauthorized",
  "quota_exhausted",
  "policy_refused",
  "unreachable",
  "refused",
  "timeout",
  "barred",
  "empty_completion",
  "local_model_missing",
  "not_ready",
  "no_embedding_model",
  "index_not_ready",
  "request_rejected",
  "feature_off",
  "consent_missing",
  "failed",
]);

/**
 * Narrow a raw IPC rejection to a provider cause. Anything unrecognized —
 * including a variant a newer host knows and this build does not — falls back
 * to `"failed"` rather than throwing, because a settings surface that crashes
 * on an unknown error is strictly worse than one that says "it did not work".
 */
export function normalizeProviderError(raw: unknown): ProviderErrorCause {
  const tag = snakeCase(engineErrorTag(raw));
  const renamed = PROVIDER_CAUSE_RENAMES.get(tag);
  if (renamed) return renamed;
  return PROVIDER_CAUSES.has(tag) ? (tag as ProviderErrorCause) : "failed";
}

/**
 * The i18n key for a cause. A `Record` over the union rather than a switch, so
 * a new cause still fails to compile here (which was the switch's whole point)
 * without ten arms that each spell the same camelCase transformation by hand.
 */
const PROVIDER_ERROR_KEY: Readonly<Record<ProviderErrorCause, string>> = {
  no_credential: "settings.ai.providerError.noCredential",
  unauthorized: "settings.ai.providerError.unauthorized",
  quota_exhausted: "settings.ai.providerError.quotaExhausted",
  policy_refused: "settings.ai.providerError.policyRefused",
  local_model_missing: "settings.ai.providerError.localModelMissing",
  not_ready: "settings.ai.providerError.notReady",
  no_embedding_model: "settings.ai.providerError.noEmbeddingModel",
  index_not_ready: "settings.ai.providerError.indexNotReady",
  request_rejected: "settings.ai.providerError.requestRejected",
  feature_off: "settings.ai.providerError.featureOff",
  consent_missing: "settings.ai.providerError.consentMissing",
  unreachable: "settings.ai.providerError.unreachable",
  refused: "settings.ai.providerError.refused",
  timeout: "settings.ai.providerError.timeout",
  barred: "settings.ai.providerError.barred",
  failed: "settings.ai.providerError.failed",
  // The one key outside the `providerError.*` block, deliberately
  // (myne-md/myne#466). "No answer, try rephrasing" already exists and already
  // says the right thing, so a second sentence with the same meaning would give
  // translators two strings to keep in step for one situation. Reaching this
  // entry at all means something classified an empty completion as an error;
  // `ai-chat.ts` routes it to the ordinary empty-result path instead, which is
  // why no production caller passes this cause today.
  empty_completion: "editor.chrome.rightPanel.aiChat.noAnswer",
};

export function providerErrorKey(cause: ProviderErrorCause): string {
  return PROVIDER_ERROR_KEY[cause];
}
