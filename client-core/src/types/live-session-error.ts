// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs` artifact + a CI
// drift check. The Rust type lives in:
//   - core/src/plugins/live/commands.rs   (LiveSessionCommandError)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `live` Tauri
 * plugin's session commands (open / apply / patch-frontmatter / close).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]`. Variant set is
 * closed; adding a variant requires updating both the Rust enum and this mirror.
 */
export type LiveSessionCommandError =
  /** Slot is `Empty`/`Recovering`/`ImportSource`. */
  | { kind: "VaultNotUnlocked" }
  /** `noteId` failed strict parse (backend bug-canary). */
  | { kind: "InvalidNoteId" }
  /** `<vault>/notes/<note_id>.myn` is missing. */
  | { kind: "NoteNotFound" }
  /** The durable blob failed to open (non-distinguishing, `protocol.md` §6.4). */
  | { kind: "CannotDecrypt" }
  /** The decoded document is not a single-`Text` `NC05` document. */
  | { kind: "Malformed" }
  /** The re-sealed blob would exceed `protocol::MAX_PLAINTEXT_LEN`. */
  | { kind: "PlaintextTooLarge" }
  /** A local edit range fell inside a surrogate pair (not a char boundary). */
  | { kind: "NotOnCharBoundary" }
  /** A local edit range was inverted or two ranges overlapped. */
  | { kind: "OutOfBounds" }
  /** No live session is open for this note (apply/close on a closed note). */
  | { kind: "NotOpen" }
  /** The note is a `kind: drawing` note; the CM6 live bridge does not apply. */
  | { kind: "DrawingNotApplicable" }
  /** Entropy unavailable re-sealing the `NC05` blob. */
  | { kind: "Csprng" }
  /** A filesystem failure on the blob read or the durable write. */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } };
