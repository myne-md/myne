// Re-export shim into `@myne/client-core/auto-lock` (myne-md/myne#479).
//
// This file held a fourth declaration of the auto-lock envelope: the three
// constants and the clamp, hand-mirrored from the desktop Rust, with a header
// naming `src-tauri/src/auto_lock.rs::effective_auto_lock_secs` as its source,
// a file that no longer holds them. The Rust home carries compile-time
// invariants that fail the build if the bounds move; this copy carried none, so
// a change to the placeholder values would have fired there and left a phone's
// timer on the old ceiling.
//
// `effectiveMobileAutoLockSecs` keeps its name here so callers are unchanged;
// the shared export is `effectiveAutoLockSecs`, without the client in the name,
// because it is not a mobile rule.
export {
  AUTO_LOCK_CEILING_SECS,
  DEFAULT_AUTO_LOCK_SECS,
  MIN_AUTO_LOCK_SECS,
  effectiveAutoLockSecs as effectiveMobileAutoLockSecs,
} from "@myne/client-core";
