// Web seam — `webviewWindow`. Wiring stub (phase3-web-client task 7).
//
// One page context, so per-webview event scoping collapses into the plain
// event subscription.

import { listen } from "./event";

export function getCurrentWebviewWindow(): {
  listen: (name: string, handler: (e: { event: string; payload: unknown }) => void) => Promise<() => void>;
} {
  return { listen };
}
