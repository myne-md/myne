// Platform seam — `@tauri-apps/api/core`.
//
// Every `invoke` in `src/` goes through this file. On desktop it is a
// straight re-export of Tauri's IPC entry point; the Phase 3 web build
// substitutes a module with the same shape that routes the same
// `(cmd, args) => Promise` call into the wasm Worker instead of Tauri IPC
// (`prd.md` "Never fork the UI"). The call shape is the contract: do not
// wrap, rename, or add arguments here — a wrapper would make the two
// implementations diverge in exactly the place the seam exists to hold
// identical.
//
// `src/platform/` is the ONLY place under `src/` allowed to import
// `@tauri-apps/*`; `scripts/check-platform-seam.mjs` enforces it in
// `pre-commit` and in CI.

export { invoke, Channel, convertFileSrc } from "@tauri-apps/api/core";
export type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
