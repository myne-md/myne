// The mobile client's first general toast surface (myne-md/myne#455).
//
// Mobile had a `Toast` PRIMITIVE and nowhere to put one. The only thing that had
// ever needed a transient message, the share-import notice, grew its own
// self-mounting component listening on a window event, a reasonable answer for
// one caller and not a surface a second caller could reach. So every other
// screen that wanted to tell the user something used a label swap or said
// nothing, which is most of what the clipboard audit found on this client.
//
// # Inherited, not rediscovered
//
// The layout below is `ShareImportToast`'s, and the two non-obvious parts are
// its hard-won details rather than defaults:
//
//   - The wrapper is a full-width fixed band and is CLICK-THROUGH. A transparent
//     handler-less element still swallows taps: transparency is not
//     pass-through. Without `pointerEvents: "none"` the band's empty left and
//     right regions eat taps meant for the TabBar and FormatBar underneath.
//   - `paddingBottom` carries the safe-area inset, so the pill clears the home
//     indicator instead of sitting under it.
//
// # One live region, here
//
// `role="status"` on the host means a message is announced once, by one element,
// for every caller, rather than each call site remembering to wrap its own
// confirmation. That is the accessibility half of myne-md/myne#455, and putting
// it on the host is what makes it structural instead of a convention.
//
// The host renders the message text only. A confirmation names the OUTCOME,
// never the copied VALUE, the rule the copy-policy module states and the reason
// its feedback arms are handed nothing to render.

import { useEffect, useState } from "react";
import { Toast } from "./feedback";

/** How long a message stays up. Matches the share-import notice. */
const DISMISS_MS = 4000;

/** The custom event a caller dispatches to show a toast. */
export const MOBILE_TOAST_EVENT = "myne:mobile-toast";

interface ToastDetail {
  message: string;
}

/**
 * Show a transient message.
 *
 * A plain function over a window event rather than a React context, for the same
 * reason `ShareImportToast` listens on one: the callers are not all inside a
 * provider, `EditorFlow`, `CreateVaultFlow` and the settings sheet sit in
 * different parts of the Stage machine, and threading a provider through all of
 * them to deliver one string would be a larger change than the feature.
 */
export function showToast(message: string): void {
  window.dispatchEvent(
    new CustomEvent<ToastDetail>(MOBILE_TOAST_EVENT, { detail: { message } }),
  );
}

/** Mount once, at the app root. */
export function ToastHost() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      if (detail?.message) setMessage(detail.message);
    };
    window.addEventListener(MOBILE_TOAST_EVENT, onToast);
    return () => window.removeEventListener(MOBILE_TOAST_EVENT, onToast);
  }, []);

  useEffect(() => {
    if (message === null) return;
    const id = window.setTimeout(() => setMessage(null), DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [message]);

  if (message === null) return null;

  return (
    <div
      role="status"
      data-testid="toast.host"
      style={{
        position: "fixed",
        insetInlineStart: 0,
        insetInlineEnd: 0,
        bottom: 24,
        display: "flex",
        justifyContent: "center",
        zIndex: 50,
        // Click-through band. See the header: a transparent element with no
        // handler still captures taps, so without this the empty regions either
        // side of the pill swallow taps meant for the bars underneath.
        pointerEvents: "none",
        // Clear the home indicator rather than sitting under it.
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <Toast>{message}</Toast>
    </div>
  );
}
