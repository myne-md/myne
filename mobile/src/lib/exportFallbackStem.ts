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
 * Hex of the name's UTF-8 bytes rather than a hash, and the choice is not
 * fussiness: hex is INJECTIVE, so this is collision-free by construction rather
 * than by improbability, and it needs no hash function in a file that would
 * otherwise have none.
 *
 * **There is no length cap, and there was one for exactly one review round.**
 * A `.slice(0, 32)` gave the injectivity away and took the argument for hex
 * with it: seventeen dots followed by `pdf` and eighteen dots followed by `pdf`
 * truncate to the same thirty-two characters, both carry `.pdf`, and the second
 * export silently overwrites the first. That is the data loss this function
 * exists to prevent, reintroduced by the truncation, under a property this
 * comment asserts four times. The names that reach here are made entirely of
 * dots, spaces and separators, which is why they sanitized away, so they are
 * short in practice; a pathological one produces a long stem, and a long
 * filename is a far smaller problem than a wrong one.
 *
 * Deterministic on purpose. Re-exporting the same attachment twice overwrites
 * its OWN earlier export rather than accumulating copies, which is the
 * behaviour every other export flow here already has.
 */
export function exportFallbackStem(filename: string): string {
  const hex = [...new TextEncoder().encode(filename)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  // `unnamed` covers the empty string, which `TextEncoder` maps to no bytes.
  // A bare `myne-export-` would end in a separator-ish dangle for no reason.
  return `myne-export-${hex || "unnamed"}`;
}
