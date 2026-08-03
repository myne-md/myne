// Prepare attachment blob URLs for the surfaces that render thumbnails (#263).
//
// On the web client an `AttachmentThumbnail` renders from a blob URL the host
// has already minted; it does not fetch. Only `AttachmentsLibrary` warmed the
// ids it was about to show, so every OTHER thumbnail surface painted blank
// boxes:
//
//   - `CoverPicker` — identical blank boxes with the filename only as a `title`
//     tooltip, so the user picks a cover blind;
//   - `CleanUnusedAttachmentsDialog` — where the thumbnails exist specifically
//     so the user sees what is about to be erased, before an irreversible
//     cryptographic erase.
//
// The rule the hook encodes: a surface that renders thumbnails warms the ids it
// renders. Scoped to what is on screen after filtering, never the whole
// catalog — warming everything would decrypt every attachment in the vault to
// paint one screenful, which on an attachment-heavy vault is gigabytes.
//
// A no-op on desktop, where `warmRefs` is absent from the host because a
// desktop thumbnail fetches its own bytes.

import { useEffect, useState } from "react";
import { getHost } from "@myne/editor/host";

/**
 * Warm `ids` and return a nonce that changes once they are ready.
 *
 * Callers pass the nonce down to their thumbnails so the tiles — which rendered
 * against the pre-warm answers — ask again. The array is read by VALUE (joined
 * into the effect key), so a caller may pass a freshly-mapped array each render
 * without re-warming on every one.
 */
export function useWarmAttachmentRefs(ids: readonly string[]): number {
  const [warmNonce, setWarmNonce] = useState(0);
  const key = ids.join(",");

  useEffect(() => {
    const warmRefs = getHost().attachments.warmRefs;
    if (warmRefs === undefined) return; // desktop — nothing to prepare
    if (key === "") return;
    let cancelled = false;
    void warmRefs(key.split(","))
      .then(() => {
        if (!cancelled) setWarmNonce((n) => n + 1);
      })
      .catch(() => {
        // Best-effort, and per-id inside the host: one attachment that will not
        // decrypt must not blank the rest. Anything unwarmed keeps the pending
        // placeholder, which is what a failed desktop fetch shows too.
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return warmNonce;
}
