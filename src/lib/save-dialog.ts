// One place that opens a native save dialog and says what happened.
//
// # Three outcomes, not two
//
// A dialog that returns no path was CANCELLED by the user: their own action, and
// not news. A dialog that THREW would not open: a failure the user cannot tell
// apart from a cancel unless something says so, and one that wrote nothing either
// way. Collapsing the second into the first is the shape R1.7 found.
//
// # Why it is shared, and what it replaced
//
// Four surfaces open one of these, and they disagreed about the failure.
// `secret-export.ts` had BOTH answers in the same file: `saveSecretAsTextFile`
// announced the failure and `saveSecretAsJsonFile` swallowed it with a comment
// calling the two indistinguishable, so a theme export whose dialog refused to
// open produced a dead button while a recovery-kit save in the same situation
// produced a message. `useDiagnostics` and `noteImageExport` each grew a third
// and fourth spelling of the same `try`/`catch`, which is also where the
// `"failed"` versus `"error"` vocabulary split came from.
//
// `SaveOutcome` is the shared dictionary those two spellings collapse into. It
// lives here rather than in a type-only module because the helper is its only
// producer, and a reader looking for "what does a save report" should land on the
// code that decides.

import { save as dialogSave } from "../platform/dialog";
import { logErrorKind } from "./vault-creation-logging";

/** The one dictionary for "did a save land", shared by every save surface. */
export type SaveOutcome = "saved" | "cancelled" | "failed";

/** What the dialog itself yielded, before anything was written. */
export type SaveTarget =
  | { kind: "path"; path: string }
  | { kind: "cancelled" }
  | { kind: "failed" };

/**
 * Open a save dialog and classify the result.
 *
 * The failure is LOGGED here rather than at each call site, for the same reason
 * the classification is: four surfaces each remembering the tag is four chances
 * to drop it, and the tag is what makes a report legible.
 *
 * A caller that gets `failed` must report it. The two `secret-export` savers do
 * that in their own idioms — one announces, one throws — and that difference is
 * deliberate: they are different APIs. What may not differ is whether the user is
 * told, which is what this helper now decides.
 */
export async function openSaveDialog(
  defaultPath: string,
  filters: Array<{ name: string; extensions: string[] }>,
): Promise<SaveTarget> {
  try {
    const path = await dialogSave({ defaultPath, filters });
    return typeof path === "string" && path.length > 0
      ? { kind: "path", path }
      : { kind: "cancelled" };
  } catch (error) {
    logErrorKind(error, "dialog-save-failed");
    return { kind: "failed" };
  }
}
