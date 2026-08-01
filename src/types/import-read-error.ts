// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust type lives in:
//   - src-tauri/src/plugins/importer/error.rs           (ImportReadError)
//   - core/src/io_failure_kind.rs                       (IoFailureKind)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `importer`
 * plugin's `import_read_dir` / `import_read_file` commands.
 *
 * **Wire shape differs from every sibling in this directory.** The Rust enum is
 * `#[serde(tag = "kind")]` — internally tagged with NO `content = "detail"` —
 * so the payload-carrying variant is FLAT (`{"kind":"Io","io_error_kind":…}`),
 * not nested under `detail` the way `NoteReadError` and friends are. Mirrored
 * here as it actually is rather than "fixed" on the Rust side: the enum had no
 * TS consumer at all until now, so changing the wire would move bytes for no
 * user-visible gain. `ioKindOf` (`src/lib/storage-pressure.ts`) already reads
 * both shapes, which is why the generic path needed no change either.
 *
 * Variant set is closed; adding a variant is an IPC contract change that
 * requires updating both the Rust enum and this mirror in the same change.
 */
export type ImportReadError =
  /**
   * The path is not absolute, escapes the user-picked import root, or is a
   * symlink resolving outside it. Carries no path — including one would leak
   * filesystem structure across the boundary.
   */
  | { kind: "PathRejected" }
  /** An I/O failure, reduced to the closed `IoFailureKind` at the boundary. */
  | { kind: "Io"; io_error_kind: IoFailureKind }
  /**
   * The file's bytes are not valid UTF-8, so it is not importable as a note —
   * Myne note plaintext is UTF-8. The Rust doc comment has always said "the TS
   * engine flags/skips it"; until myne-md/myne#223 nothing in `src/` read this
   * variant at all, so one legacy-encoded `.md` killed the whole run instead.
   */
  | { kind: "NotUtf8" };

/** Narrow an unknown rejection to an `ImportReadError`. */
export function isImportReadError(e: unknown): e is ImportReadError {
  if (e === null || typeof e !== "object") return false;
  const kind = (e as { kind?: unknown }).kind;
  return kind === "PathRejected" || kind === "Io" || kind === "NotUtf8";
}
