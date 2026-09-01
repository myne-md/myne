// Shared constants for the OS title-bar strip that App.tsx renders on every
// stage (MYND-166 behavioral pass). The editor portals its own controls
// (vault switcher + sidebar toggles) into the slot; other stages leave it
// empty (a plain window-drag region).

export const TITLEBAR_SLOT_ID = "myne-titlebar-slot";

/**
 * Whether the host floats window controls OVER the content's top-left corner,
 * so the editor's own controls must be inset past them.
 *
 * True for a macOS Tauri window: `tauri.conf.json` sets
 * `titleBarStyle: "Overlay"` with `trafficLightPosition` x:16.
 *
 * **Named for the property, not the platform** (phase3-web-client task 70). It
 * was `IS_MAC`, a plain `navigator.userAgent` test — which is also true in a
 * Mac BROWSER, where there are no traffic lights and nothing to clear, so the
 * web editor reserved 86 px of empty space on macOS and only on macOS. The web
 * build substitutes this module (`web/src/screens/titlebar.ts`); the rename is
 * what makes the substitute obviously correct instead of a lie about the
 * user's operating system.
 */
export const HAS_OVERLAY_WINDOW_CONTROLS =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** Left gap (px) for the macOS traffic-light cluster (x:16 + 3 buttons). */
export const TRAFFIC_LIGHT_GAP = 70;

/**
 * Whether the host draws a native title bar the application must live under
 * (phase3-web-client task 96).
 *
 * True for a Tauri window. A browser tab has none — its chrome is the browser's
 * and sits outside the page entirely — so the 38 px strip `App.tsx` reserves
 * above every pre-unlock screen is, there, 38 px of nothing above a login form.
 */
export const HAS_NATIVE_TITLE_BAR = true;

/**
 * Where a control in the title-bar row sits, and how tall it is.
 *
 * That row holds two families of control laid out by different means. The
 * sidebar toggles, the back/forward nav and the note-actions "…" are floated
 * into the editor's corners by `screens/Editor.tsx` (absolute, measured from
 * the top). The tab strip's own `+` and overflow buttons are flex children of
 * the 38px strip (`notes/components/TabStrip.tsx`). They end up side by side
 * and have to read as one row.
 *
 * They did not. The strip's buttons were 28px tall and centred in the strip's
 * CONTENT box, which begins below its top padding, so they landed two pixels
 * lower than the floated ones: a visibly larger gap above the overflow caret
 * than above the "…" immediately to its right (myne-md/myne#612).
 *
 * They live HERE rather than with either family, because a constant owned by
 * one of two consumers is a constant the other one can have moved out from
 * under it. Platform-invariant: this is alignment arithmetic, not a fact about
 * the host, so the web build re-exports both unchanged.
 */
export const TITLE_BAR_CONTROL_TOP = 6;
export const TITLE_BAR_CONTROL_HEIGHT = 26;

/**
 * The window-drag attribute, as spreadable props.
 *
 * `data-tauri-drag-region` is intercepted by the Tauri host on every platform
 * (the Chromium-only `-webkit-app-region: drag` is unsupported in WKWebView and
 * WebKitGTK). Nothing intercepts it in a browser, where it is an inert
 * attribute advertising a host that is not there — so the web build's
 * substitute returns nothing at all and the attribute never reaches the DOM.
 */
export function dragRegionProps(): Record<string, boolean> {
  return { "data-tauri-drag-region": true };
}
