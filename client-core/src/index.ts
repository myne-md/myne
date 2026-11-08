// `@myne/client-core`: the cross-client decision layer (myne-md/myne#242).
//
// **Deliberately not a flat `export *` barrel.** Four of the error modules
// export a function called `isIoError`, each narrowing a DIFFERENT union, and a
// star barrel would either collide at build time or, worse, resolve to whichever
// one the bundler saw last. So the barrel carries the root vocabulary that has
// exactly one meaning package-wide, and every per-command error union is reached
// by its own subpath:
//
//     import type { NoteUpdateError } from "@myne/client-core/types/note-update-error";
//     import { isIoError }            from "@myne/client-core/types/note-update-error";
//
// Both clients keep one-line re-export shims at `src/types/<name>.ts` and
// `mobile/src/types/<name>.ts` so their existing importers are unchanged, which
// is the shape `src/dialect/*.ts` already uses against `@myne/dialect`.

/**
 * The closed IO-failure vocabulary every command error carries, mirroring
 * `core/src/io_failure_kind.rs`. One declaration for the whole tree: it used to
 * exist twice, here and in `lib/stage.ts`, and two of its twelve consumers
 * resolved the second copy.
 */
export type { IoFailureKind } from "./types/vault-unlock-error";

/**
 * The `.ics` codec (myne-md/myne#1037 task 10): one pure reader and writer of
 * calendar interchange files, shared by desktop, web and mobile. It needs no host,
 * which is the criterion this package states, and the device zone enters as a
 * parameter rather than as a global read.
 */
export {
  ICS_BYTE_CAP,
  exportEvents,
  importEvents,
  type IcsEvent,
  type IcsImport,
  type IcsRefusal,
  type IcsWarning,
} from "./ics";

/** The three-state unlock slot, mirroring `core/src/plugins/vault_unlock/state.rs`. */
export type { SlotKind } from "./types/slot-kind";

/** The `vault_status` boot probe, mirroring `core/src/plugins/vault_unlock/`. */
export type {
  VaultStatus,
  VaultStatusError,
  VaultStatusResult,
} from "./types/vault-status";

/** The `vault_list` multi-vault enumeration (SYNC-4). */
export type {
  VaultSummary,
  VaultSummaryStatus,
  VaultListError,
  VaultListResult,
} from "./types/vault-summary";

/**
 * The A6 auto-lock envelope: the three bounds and the clamp a client's own
 * WebView timer compares against.
 *
 * The one RUNTIME export here: everything above is `export type` and erases.
 *
 * It is exported from the barrel rather than by subpath alone because this is
 * the package's front door and `auto-lock` is the one module with no name to
 * collide over. The types keep their subpaths for the reason at the top of this
 * file, four of them export a same-named `isIoError`.
 *
 * That also gives this file production importers, which it needs:
 * `scripts/check-unwired.mjs` watches `client-core/src` and a test-only importer
 * does not count. A barrel nothing imports is a barrel whose stale re-export
 * path fails nothing.
 */
export {
  AUTO_LOCK_CEILING_SECS,
  DEFAULT_AUTO_LOCK_SECS,
  MIN_AUTO_LOCK_SECS,
  effectiveAutoLockSecs,
} from "./auto-lock";
