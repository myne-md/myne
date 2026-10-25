// The frontmatter markers the HOST owns, which no view may ever write.
//
// `archived`, `deleted` and `trashed` are the three keys the app sets to take a
// note out of the working set. A manifest that could write one of them could
// hide the reader's notes from their own vault, which is why the strict import
// reader refuses such a manifest outright (`protocol::ViewManifestError::
// ReservedWriteField`) rather than dropping the key.
//
// This mirror exists for the AUTHORING surface, and only for it: the form does
// not OFFER these keys, so a user cannot compose a manifest the import path will
// reject. It is not an authority. The Rust side still refuses, and it refuses
// even when the key is declared, so a surface that forgot this list produces a
// named import error rather than a grant.
//
// Mirrors `protocol::RESERVED_WRITE_FIELDS` (view_manifest.rs). A change there is
// a change here, and this comment is the only cross-language link.

export const RESERVED_WRITE_FIELDS: readonly string[] = [
  "archived",
  "deleted",
  "trashed",
];

export function isReservedWriteField(key: string): boolean {
  return RESERVED_WRITE_FIELDS.includes(key);
}
