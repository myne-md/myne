// Platform seam — `@tauri-apps/api/window`.
//
// One member, one caller: `lib/app-window.ts`'s `closeApp()`. It calls
// `destroy()` rather than `close()` for the reason that file documents —
// `destroy()` is non-cancellable, so a stale `onCloseRequested` listener cannot
// `preventDefault()` and silently swallow a fail-closed exit.
//
// See `./core.ts` for why this tree has a seam.

export { getCurrentWindow } from "@tauri-apps/api/window";
