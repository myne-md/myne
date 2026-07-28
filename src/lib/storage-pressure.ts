// Is this failure the storage running out? (phase3-web-client task 91)
//
// # Why this is its own module and not an `if` in the save-status component
//
// The same question is asked in more than one place — a note save, an attachment
// import, a singleton flush — and each one reaches a different error ENUM. What
// they share is the closed `IoFailureKind` the seam maps every storage failure
// into, so the predicate belongs where all of them can reach it rather than
// being re-derived per call site with a slightly different shape each time.
//
// # Why `NoSpace` and not a browser-specific check
//
// The OPFS backend already maps `QuotaExceededError` to `IoFailureKind::NoSpace`
// at the seam boundary, deliberately: "the underlying medium ran out of writable
// bytes" is the same condition and the same user remedy on both clients. So this
// asks the closed enum, and a caller on desktop gets the right answer for a full
// disk without anything web-specific being involved.

import type { IoFailureKind } from "./stage";

/** Shapes the backends use to carry an `IoFailureKind` across IPC. */
type WithIoKind =
  | { io_error_kind?: IoFailureKind }
  | { detail?: { io_error_kind?: IoFailureKind } }
  | { kind?: string; detail?: { io_error_kind?: IoFailureKind } };

/**
 * The `IoFailureKind` an arbitrary backend error carries, or `null`.
 *
 * Tolerant of both wire shapes because both exist: some enums put the kind at
 * the top level, others nest it under `detail` per the
 * `#[serde(tag = "kind", content = "detail")]` convention. A caller should not
 * have to know which enum it caught.
 */
export function ioKindOf(error: unknown): IoFailureKind | null {
  if (error === null || typeof error !== "object") return null;
  const e = error as WithIoKind;
  const direct = (e as { io_error_kind?: IoFailureKind }).io_error_kind;
  if (typeof direct === "string") return direct;
  const nested = (e as { detail?: { io_error_kind?: IoFailureKind } }).detail?.io_error_kind;
  return typeof nested === "string" ? nested : null;
}

/**
 * Whether this failure is the storage being full.
 *
 * Deliberately narrow: only `NoSpace`. A `PermissionDenied` from a locked OPFS
 * handle and an `Other` from a stale one are storage failures too, and telling
 * the user to free space would send them to do something that cannot help.
 */
export function isStorageFull(error: unknown): boolean {
  return ioKindOf(error) === "NoSpace";
}
