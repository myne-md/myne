// Platform seam — `@tauri-apps/api/core`.
//
// ── why the mobile client has a seam at all ─────────────────────────────────
//
// Not for the reason the desktop one exists. `src/platform/` is substituted at
// build time so the same tree compiles for a browser that has no Tauri; mobile
// is a Tauri host on both of its targets and there is nothing to substitute.
//
// It exists for two other reasons, and both are load-bearing:
//
//   1. **The guard needs an exempt directory to name.** `mobile/src` joined
//      `check-platform-seam.mjs`'s roots in myne#492. A root whose seam is
//      `null` bans `@tauri-apps/*` outright, which is a rule mobile cannot
//      satisfy — so the guard's scope over this tree IS this directory.
//   2. **Twin drift.** Four module pairs (`vault-status.ts`,
//      `vault-slot-kind.ts`, `vault-recover.ts`, `vault-change-password.ts`)
//      differed from their desktop twins in the import line and in NOTHING
//      else. That class of difference grows with every new mobile file, and it
//      is the shape that hid a missing tombstone filter in the mobile Trash
//      list for months while both trees stayed green.
//
// Same rule as desktop about wrapping: the `(cmd, args) => Promise` call shape
// is the contract. Do not wrap, rename, or add arguments here — a wrapper is
// exactly what makes two clients that read the same vault diverge.
//
// `mobile/src/platform/` is the ONLY place under `mobile/src` allowed to import
// `@tauri-apps/*`. The iOS-versus-Android presentation seam that used to live
// at this path is `mobile/src/formfactor/` now; the two were never the same
// thing and sharing a directory name made them read as one.

export { invoke, Channel, convertFileSrc } from "@tauri-apps/api/core";
export type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
