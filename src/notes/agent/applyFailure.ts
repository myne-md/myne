// What a whole-call apply failure is called (myne-md/myne#894).
//
// `agent.review.applyFailed` was one sentence for every cause, and the `catch`
// that used it discarded the error. `AgentError` has a dozen whole-call variants
// reachable at that point, the run gone, the vault locked, the write refused by
// the live-session guard, the restore point failing, and a real report of "The
// changes could not be applied." was therefore unfalsifiable: the user had a
// sentence, the log had nothing (`agent_apply` emitted no tracing at all), and
// the shortest path back to the cause was a rebuild.
//
// So the wire tag is read here and named. Two halves, both required:
//
//   - `agentErrorTag` is the ONE reader of the rejection shape, the same
//     extraction `engineErrorTag` performs for the inference seam. Tauri
//     serializes `AgentError` as `{ kind, detail }`, but a bare string arrives
//     from some paths, and an unrecognized shape must not be mistaken for a
//     known kind.
//   - `applyFailureMessage` maps the tag to a sentence with a `switch` over
//     LITERAL keys, like `removalFlagLabel` and `emptyRunLabel` before it. A
//     computed `t(key)` is invisible to `scripts/check-i18n.mjs`, which scans
//     static quoted-key call sites by design (an expression-aware scanner is a
//     scanner with a bypass), so a table of assembled keys would put every one of
//     these sentences outside the only check that can see them.
//
// The mapping is deliberately one-directional: a tag with no arm falls back to
// the generic sentence rather than to an empty string, because a cause the UI
// cannot name is still a failure the user has to be told about. The arms are the
// causes a user can act on or that explain a missing write; the rest
// (`gateRefused`, the provider kinds, the individual-approval bug) arrive on other
// paths and are not claims this card should make.

/**
 * The `AgentError` variant tag of a raw IPC rejection, or `""` when the value is
 * not one. Pure, and the only place the shape is decoded.
 */
export function agentErrorTag(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw !== null && typeof raw === "object" && "kind" in raw) {
    return String((raw as { kind: unknown }).kind);
  }
  return "";
}

/**
 * The comparison form of a tag: lowercase, separators removed.
 *
 * **This exists because the first version of this file compared raw strings and
 * silently matched nothing** (myne-md/myne#894, found by a user pressing
 * Approve: "it still says it could not be applied"). The wire tag is the Rust
 * VARIANT NAME, `AgentError`'s derive carries `tag`/`content` and no
 * `rename_all`, unlike its sibling `EditRejection` one enum over, while
 * `kind()`, the tag the host LOGS, is snake_case. So the failure arrives as
 * `WriteFailed`, the map compared `"write_failed"`, and every cause fell through
 * to the generic sentence. The host's log had the answer the whole time and the
 * card could not read it.
 *
 * Normalising rather than picking one spelling: the two enums beside each other
 * already disagree, a future `rename_all` is exactly the kind of edit that makes
 * a hand-written table stale, and lowercase-without-separators is stable under
 * all three forms (`WriteFailed`, `writeFailed`, `write_failed`).
 */
export function normalizeAgentErrorTag(raw: unknown): string {
  return agentErrorTag(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * The sentence for a failed approval, named by cause.
 *
 * Every arm is a claim about the vault, so each one says what the user should
 * conclude. Most are guarded before any write, so they can say "nothing was
 * written" (`noSuchRun`, `cancelled`, `slotNotUnlocked`, `restorePointFailed`).
 * `writeFailed` CANNOT, and that is a correction from review: it is one tag for
 * ten batch refusals, and `NoteBatchError::CommittedPendingPublish` is the arm
 * whose own doc says the batch committed and the caller must not roll back, so
 * the sentence says only that the write did not finish.
 */
export function applyFailureMessage(raw: unknown, t: (key: string) => string): string {
  switch (normalizeAgentErrorTag(raw)) {
    case "nosuchrun":
      return t("agent.review.applyFailedCause.noSuchRun");
    case "cancelled":
      return t("agent.review.applyFailedCause.cancelled");
    case "slotnotunlocked":
      return t("agent.review.applyFailedCause.locked");
    case "aidisabled":
      return t("agent.review.applyFailedCause.aiDisabled");
    case "writefailed":
      return t("agent.review.applyFailedCause.write");
    case "readfailed":
      return t("agent.review.applyFailedCause.read");
    case "restorepointfailed":
      return t("agent.review.applyFailedCause.restorePoint");
    default:
      return t("agent.review.applyFailed");
  }
}
