// Platform seam — `@tauri-apps/api/window`.
//
// Host-window lifecycle: destroy, fullscreen state, blur/focus listeners.
// A browser tab has no window to destroy and no OS-level fullscreen the page
// controls, so the web implementation reports fullscreen from the Fullscreen
// API and makes destroy a typed unsupported outcome — the fail-closed CTA
// that calls it gets a web outcome in task 95 rather than a dead button.

export { getCurrentWindow } from "@tauri-apps/api/window";
