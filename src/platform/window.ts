// Platform seam — `@tauri-apps/api/window`.
//
// Host-window lifecycle: destroy, fullscreen state, blur/focus listeners.
// A browser tab has no window to destroy and no OS-level fullscreen the page
// controls, so the web implementation reports fullscreen from the Fullscreen
// API and makes destroy a typed unsupported outcome — the fail-closed CTA
// that calls it gets a web outcome in task 95 rather than a dead button.

export { getCurrentWindow } from "@tauri-apps/api/window";

import { availableMonitors, primaryMonitor, type Monitor } from "@tauri-apps/api/window";

/** A display's bounds in physical pixels (myne#678 task 6). Structurally the
 *  `Display` `clampDetachedGeometry` takes; declared locally rather than imported
 *  so the desktop and mobile `window.ts` seams stay byte-identical twins (mobile's
 *  platform tree does not cross-import from `src/`). */
type Display = { x: number; y: number; width: number; height: number };

/**
 * The connected displays + the primary, in PHYSICAL pixels (myne#678 task 6).
 *
 * The same space the detached-window snapshot and spawn use, so
 * `clampDetachedGeometry` compares like with like (a `Monitor`'s `position` and
 * `size` are physical). The web seam returns a single virtual display, since a
 * browser tab has no OS monitor list and never spawns a detached window anyway.
 */
export async function readDisplays(): Promise<{ displays: Display[]; primary: Display }> {
  const toDisplay = (m: Monitor): Display => ({
    x: m.position.x,
    y: m.position.y,
    width: m.size.width,
    height: m.size.height,
  });
  const [all, prim] = await Promise.all([availableMonitors(), primaryMonitor()]);
  const displays = all.map(toDisplay);
  const primary = prim
    ? toDisplay(prim)
    : (displays[0] ?? { x: 0, y: 0, width: 1920, height: 1080 });
  return { displays: displays.length > 0 ? displays : [primary], primary };
}
