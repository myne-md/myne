// Shared constants for the OS title-bar strip that App.tsx renders on every
// stage (MYND-166 behavioral pass). The editor portals its own controls
// (vault switcher + sidebar toggles) into the slot; other stages leave it
// empty (a plain window-drag region).

export const TITLEBAR_SLOT_ID = "myne-titlebar-slot";

/** macOS overlay title bar floats the traffic lights over the content
 *  (`tauri.conf.json` `titleBarStyle: "Overlay"`, `trafficLightPosition`
 *  x:16). Reserve a left gap there so the editor controls clear them. */
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** Left gap (px) for the macOS traffic-light cluster (x:16 + 3 buttons). */
export const TRAFFIC_LIGHT_GAP = 70;
