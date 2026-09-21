// The fallback stem an attachment export uses when its filename sanitizes away
// entirely (myne-md/myne#517).
//
// The literal `"attachment"` sat here first, restored from the TypeScript this
// change replaced, and it was the worst possible choice for one specific
// reason: it is byte-identical to `auto_filename`'s output in
// `core/src/plugins/attachments/commands.rs`, which is
// `format!("attachment.{ext}")`, the app's own default name for an untitled
// import. So the one name the fallback could land on was the single most likely
// name to be on disk already, and `attachmentExport(id, dest, true)` overwrites
// without asking. An attachment renamed to `..pdf` would have destroyed an
// ordinary `attachment.pdf` exported earlier.
//
// **What this does NOT fix**, so nobody reads it as more than it is: mobile
// still overwrites silently when two exports resolve to the same basename. That
// is pre-existing, reachable on `develop` today with two attachments sharing a
// name, needs a non-clobbering destination or a confirmation the `EditorHost`
// seam cannot express, and is out of scope here. What this removes is the NEW
// path this change would otherwise have opened.
//
// **Why the name and not the attachment id**, since the decision said id.
// `EditorHost.pickExportDestination` is `(filename: string) => Promise<string>`
// (`editor/src/host.ts`), and the id never crosses it; passing one is a change
// to the shared seam, which the same decision ruled out. Deriving from the name
// keeps the property that was actually being asked for and costs one call site.

/**
 * A stem that cannot be `auto_filename`'s output, derived from `filename`.
 *
 * Hex of the name's UTF-8 bytes rather than a hash, for inputs up to
 * {@link HEX_INPUT_LIMIT} bytes: hex is INJECTIVE, so within that range this is
 * collision-free by construction rather than by improbability.
 *
 * **There is a length bound, and the history of it is worth two sentences
 * because both directions have shipped.** A `.slice(0, 32)` cap gave the
 * injectivity away and took the argument for hex with it: seventeen dots
 * followed by `pdf` and eighteen dots followed by `pdf` truncate to the same
 * thirty-two characters, both carry `.pdf`, and the second export silently
 * overwrites the first. That cap was removed. Removing it unbounded the output
 * instead, and hex DOUBLES its input: `myne-export-` is 12 bytes, so a
 * dots-only name of about 120 bytes produces a basename past `NAME_MAX` (255)
 * and the write fails with `ENAMETOOLONG`. That is a REGRESSION against the
 * merge base, where the fallback was the literal `"attachment"` and any length
 * exported fine, and it is reachable the same way the `..` case is: the rename
 * prompt (`editor/src/attachments/fileCardActions.ts`) rejects only the empty
 * and unchanged cases and caps nothing. The comment here used to dismiss this
 * as "a long filename is a far smaller problem than a wrong one", which stops
 * being true at the point the write fails.
 *
 * **So the bound is back, and the shape is what keeps it honest.** A total
 * injective map from unbounded strings into bounded ones does not exist, by
 * pigeonhole, so any bounded scheme gives something up and the only question is
 * where and whether it is said out loud. Here: injective BY CONSTRUCTION at or
 * below {@link HEX_INPUT_LIMIT} bytes of UTF-8 input, and collision-RESISTANT
 * above it, via SHA-256 through the platform's own Web Crypto rather than
 * anything hand-rolled. Do not "restore" injectivity above the bound by truncating: that
 * is the `.slice(0, 32)` defect with a longer constant.
 *
 * **The two forms cannot collide with each other**, which is the part a reader
 * should check rather than trust: the short form's first character after
 * `myne-export-` is a hex digit, the long form's is `h`, and the empty input's
 * is `u`. Three disjoint families by first character.
 *
 * `async` because Web Crypto's digest is. The one caller
 * (`mobile/src/editor-host.ts`) is already an async seam method, so the cost is
 * one `await`.
 *
 * Deterministic on purpose. Re-exporting the same attachment twice overwrites
 * its OWN earlier export rather than accumulating copies, which is the
 * behaviour every other export flow here already has.
 */
export const HEX_INPUT_LIMIT = 64;

export async function exportFallbackStem(filename: string): Promise<string> {
  const bytes = new TextEncoder().encode(filename);
  const hex = (source: Uint8Array) =>
    [...source].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  // `unnamed` covers the empty string, which `TextEncoder` maps to no bytes.
  // A bare `myne-export-` would end in a separator-ish dangle for no reason.
  if (bytes.length === 0) return "myne-export-unnamed";
  if (bytes.length <= HEX_INPUT_LIMIT) return `myne-export-${hex(bytes)}`;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `myne-export-h${hex(new Uint8Array(digest))}`;
}
