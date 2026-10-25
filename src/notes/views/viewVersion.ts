// The version rule for a locally edited saved view (view-manifests task 8).
//
// THE RULE. A view's `version` is maintained by the app and is never a form
// field: an edit that changes the definition increments it, and an edit that
// changes nothing leaves it alone. That second half is not politeness. The import
// path orders an arriving manifest against the stored one by version, so a save
// that bumped on every click would turn "no change" into "a newer version you
// have not seen", and every re-import of the same file would stop being the
// harmless no-op it is meant to be.
//
// WHY A FINGERPRINT AND NOT THE CANONICAL BYTES. The canonical wire encoding
// lives in `protocol::canonical_encode_saved_view` and is the one authority on
// what those bytes are; export calls it through a host command rather than
// re-deriving it here. What this module needs is only the QUESTION "did the
// definition change", so it answers that with a fingerprint of the logical value:
// keys sorted, absent and empty-array-valued fields dropped (the encoder omits
// both), strings NFC-normalised (the encoder normalises). It is deliberately not
// a wire format and must never be written to disk or compared against Rust bytes.
//
// `version` is excluded from the fingerprint, because it is the answer being
// computed rather than part of the question.

import type { SavedView } from "../../lib/prefs";

/** What a fingerprint comparison may look at: everything but `version`. */
type DefinitionFields = Omit<SavedView, "version">;

/** The fields that describe the view rather than record its history. */
function definitionOf(view: SavedView): DefinitionFields {
  const { version: _version, ...definition } = view;
  return definition;
}

/**
 * Collapse a value to its comparison form: NFC strings, sorted keys, and absent
 * or empty equivalences the canonical encoder also collapses.
 */
function normalize(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map(normalize).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = normalize(source[key]);
      if (item !== undefined) out[key] = item;
    }
    return out;
  }
  return value;
}

/**
 * A stable fingerprint of a view's definition. Two views that the canonical
 * encoder would emit identically (modulo their `version`) fingerprint equal.
 */
export function viewDefinitionFingerprint(view: SavedView): string {
  return JSON.stringify(normalize(definitionOf(view)) ?? {});
}

/**
 * The version a local edit should be saved at: unchanged when the definition did
 * not change, one higher when it did. A view that never had a version stays
 * without one when its first save changes nothing, so a no-op save leaves a
 * pre-feature view byte-identical rather than quietly versioning it.
 */
export function nextViewVersion(
  previous: SavedView,
  next: SavedView,
): number | undefined {
  if (viewDefinitionFingerprint(previous) === viewDefinitionFingerprint(next)) {
    return previous.version;
  }
  return (previous.version ?? 0) + 1;
}

/** The definition to persist for a local edit: `next` with its version settled.
 *  An absent version is DELETED rather than set to `undefined`, so the object
 *  that crosses IPC carries no key at all. */
export function withNextVersion(previous: SavedView, next: SavedView): SavedView {
  const version = nextViewVersion(previous, next);
  const out: SavedView = { ...next };
  if (version === undefined) delete out.version;
  else out.version = version;
  return out;
}
