// The web build's `src/screens/titlebar` (phase3-web-client task 70).
//
// # A browser tab has no traffic lights, and the shared constants assume it does
//
// `IS_MAC` is a `navigator.userAgent` test, so it is TRUE in a Mac browser —
// and the one consumer reads it as "the window manager floats three buttons
// over my top-left corner, inset past them":
//
//     const leftToggleX = IS_MAC && !isFullscreen ? TRAFFIC_LIGHT_GAP + 16 : 12;
//
// That is true of a Tauri window with `titleBarStyle: "Overlay"`
// (`tauri.conf.json`) and false of every browser tab, where the page's origin
// is the top-left of the content area and there is nothing to clear. Left
// inherited, the web editor reserves 86 px of empty space on macOS and only on
// macOS — a real layout bug, visible to exactly the users most likely to be
// running the desktop app too, i.e. the ones best placed to notice the
// difference and read it as a broken build.
//
// # Why substitute the module rather than seam the constant
//
// The value is a fact about the WINDOW CHROME, and it is consumed as a plain
// constant at a layout site. Routing it through `src/platform/` would mean a
// seam module whose entire surface is one number, and the substitution
// mechanism for exactly this — a shared module the web build replaces
// wholesale — already exists in `web/vite.config.ts`.
//
// The shared constant was renamed from `IS_MAC` to
// `HAS_OVERLAY_WINDOW_CONTROLS` in the same change, and that rename is what
// makes this substitute honest rather than a lie about the user's operating
// system: a Mac browser IS a Mac, and it does NOT have overlay window controls.
// Those are two different questions, and only one of them is a layout input.

export {
  TITLEBAR_SLOT_ID,
  // Alignment arithmetic for the title-bar row, identical on every host.
  TITLE_BAR_CONTROL_TOP,
  TITLE_BAR_CONTROL_HEIGHT,
  TITLE_BAR_RIGHT_EDGE,
} from "../../../src/screens/titlebar";

/** No window controls float over a page: the tab's chrome is above it. */
export const HAS_OVERLAY_WINDOW_CONTROLS = false;

/** Zero — there is no traffic-light cluster to clear. Kept as an export so the
 *  module's shape matches the one it replaces. */
export const TRAFFIC_LIGHT_GAP = 0;

/** A tab has no native title bar: the browser's chrome is outside the page. */
export const HAS_NATIVE_TITLE_BAR = false;

/** Nothing — there is no host to intercept the attribute (task 96). */
export function dragRegionProps(): Record<string, boolean> {
  return {};
}
