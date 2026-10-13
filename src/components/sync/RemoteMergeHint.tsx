// The ASM-6→B / #422 "updated from another device" hint.
//
// Subscribes to the sync cycle's `sync://remote-merged` signal (#419) — emitted
// once per NC05 note whose local copy an automatic CRDT merge reconciled with a
// concurrent remote edit this cycle — and raises a calm `info` toast. The hint is
// silent BY CONSTRUCTION for a local-only edit, a no-op merge, or when sync is
// off / the vault is locked, because the backend emits nothing in those cases
// (the event fires only inside the orchestrator's NC05 merge branch). There is no
// resolve / undo affordance: a CRDT merge is not a conflict to act on, and
// recovery is the note's own synced history (ASM-12→B), not an undo button.
//
// It is ALSO silent for a LIVE peer edit, and that is a separate signal on
// purpose (myne-md/myne#857): the live channel emits `sync://live-remote-merged`,
// which only the pane listens to, because a change arriving in the note the user
// is watching needs no notice. Every device sees the owner's row as `owner` too,
// so this hint used to fire on BOTH sides of a two-person session: the editor for
// its own echoed edit, and the peer for the live change.
//
// Headless: it draws no DOM of its own — the shared <Toaster> renders the toast,
// so the merge hint looks and stacks like every other toast. The tone is
// deliberately `info`, never `error`: a merge from your own other device is
// normal, not a failure (PRODUCT.md honest-not-alarming).

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "../../platform/event";
import { toast } from "../toast/toastStore";

export function RemoteMergeHint(): null {
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        const handle = await listen("sync://remote-merged", () => {
          if (cancelled) return;
          toast({
            message: t("sync.remoteMergeHint"),
            variant: "info",
            testId: "sync.remote-merge-hint",
          });
        });
        // Unsubscribed before the async listen resolved → tear down immediately.
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Not inside a host with an event channel (web worker seam absent in a
        // unit context, or sync unavailable) → no hint, no throw.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [t]);

  return null;
}
