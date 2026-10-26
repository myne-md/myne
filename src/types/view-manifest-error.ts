// TypeScript mirrors of the two Rust enums the manifest import crosses IPC with
// (view-manifests, myne-md/myne#922 task 9).
//
// `ViewManifestError` is the strict reader's closed refusal set
// (`protocol/src/view_manifest.rs`). It is rendered to the user, which is why the
// variants that carry a value carry it: `UnknownKey` names the key this build does
// not know — the arm that makes a later additive key (`template`) safe, because an
// older client says which key it refused rather than importing a manifest minus
// it — and `ReservedWriteField` names the host-owned marker.
//
// `ViewManifestReadError` wraps it with the two things that can go wrong before
// parsing: the file could not be read, or the blocking task died.
//
// Both are `#[serde(tag = "kind", content = "detail")]` on the Rust side, so these
// are discriminated unions keyed on `kind`.

/** Why the strict reader refused a file. Mirrors `protocol::ViewManifestError`. */
export type ViewManifestError =
  /** A top-level key this format does not define. */
  | { kind: "UnknownKey"; detail: string }
  /** A `write_fields` entry naming a marker the host owns. */
  | { kind: "ReservedWriteField"; detail: string }
  /** No `version` key: a file cannot be ordered against the stored definition. */
  | { kind: "VersionRequired" }
  | { kind: "TooLarge" }
  | { kind: "Malformed" }
  | { kind: "MissingField" }
  | { kind: "WrongType" }
  | { kind: "Unrepresentable" };

/** Why reading a manifest file failed. Mirrors `ViewManifestReadError`. */
export type ViewManifestReadError =
  | { kind: "Unreadable"; detail: { io_error_kind: string } }
  | { kind: "Invalid"; detail: { reason: ViewManifestError } }
  | { kind: "JoinFailure" };

/** Narrowing helper for a caught rejection: a foreign value is not a read error. */
export function isViewManifestReadError(
  value: unknown,
): value is ViewManifestReadError {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "Unreadable" || kind === "Invalid" || kind === "JoinFailure";
}
