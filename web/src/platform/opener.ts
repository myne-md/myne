// Web seam — `opener`. Wiring stub (phase3-web-client task 7).
//
// `openUrl` has a browser equivalent and gets it here, because it is correct
// and needs no transport. `openPath` and `revealItemInDir` have none — a page
// cannot open a local file in the user's default app nor reveal it in a file
// manager — and are permanently unsupported, not pending.

import { unsupported } from "../../../src/platform/unsupported";

export async function openUrl(url: string | URL, _openWith?: string): Promise<void> {
  // `openWith` names an OS application; a page cannot choose one, so it is
  // accepted for shape and ignored. The browser opens the URL in a new tab.
  window.open(String(url), "_blank", "noopener,noreferrer");
}
export async function openPath(_path: string, _openWith?: string): Promise<void> {
  return unsupported("opener.openPath");
}
export async function revealItemInDir(_path: string | string[]): Promise<void> {
  return unsupported("opener.revealItemInDir");
}
