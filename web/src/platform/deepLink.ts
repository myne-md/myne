// Web seam — `deepLink` (phase3-web-client task 25).
//
// Tauri's deep-link plugin registers an OS URL-scheme handler (`myne://…`) so
// the operating system can hand a running app a URL. **A page cannot register
// an OS scheme handler**, and that is not a gap a browser API fills — it is what
// separates an installed application from a document.
//
// The browser's nearest concept is the URL the page was *already* loaded with,
// and task 64 gives the web client real history/routing over that. Conflating
// the two here would be wrong in a specific way: a deep link is a message that
// arrives *while running*, and `location` is a value that was fixed at load.

import { unsupported } from "../../../src/platform/unsupported";

export async function loadDeepLink(): Promise<{
  getCurrent: () => Promise<string[] | null>;
  onOpenUrl: (handler: (urls: string[]) => void) => Promise<() => void>;
}> {
  return {
    /**
     * `null` — "no deep link launched this session" — rather than a refusal.
     *
     * That is the honest answer, not a stub: on desktop `getCurrent()` returns
     * `null` for every ordinary launch too, and every caller already handles it.
     * Refusing would turn a normal state into an error the UI must special-case.
     */
    getCurrent: async () => null,

    /**
     * **Refused.** Subscribing implies a URL can arrive later, and on web none
     * can. A no-op subscription would be a listener that silently never fires —
     * indistinguishable from "the feature is broken" and impossible to gate on.
     */
    onOpenUrl: async () => unsupported("deepLink.onOpenUrl"),
  };
}
