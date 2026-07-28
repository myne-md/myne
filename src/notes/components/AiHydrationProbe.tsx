// `<AiHydrationProbe>` — a zero-chrome, test-only observability surface for the
// AI embedding-index hydrate outcome (MYND-453, ai-embeddings-persistence task
// 8). Subscribes to the backend `ai://vectors-hydrated` event (emitted once the
// detached embed-on-unlock walk settles) and reflects its bounded counters onto
// `data-*` attributes so the real-IPC E2E harness can distinguish a persistence
// HIT from a full REBUILD without reading a log.
//
// It renders nothing visible (a display:none marker). This is a SYNC-8
// `data-testid` observability hook — NOT a feature surface: the counters carry
// only totals + one boolean (never a note_id / vector / nonce — DENY-list
// clean), and the element is absent until the first hydrate event fires.
//
// The two E2E-load-bearing states (asserted by `ai-embeddings-persistence.e2e.ts`):
//   - persistence HIT   → data-loaded-from-blob="true",  data-reembedded="0"
//   - full REBUILD/cold → data-loaded-from-blob="false", data-reembedded>"0"
// (a model swap invalidates the model-identity tuple → fall-to-rebuild.)

import { useEffect, useState } from "react";
import { listen } from "../../platform/event";

/** Backend event name — mirror of `AI_VECTORS_HYDRATED_EVENT` (Rust,
 *  `src-tauri/src/plugins/local_inference/hydrate.rs`). */
const AI_VECTORS_HYDRATED_EVENT = "ai://vectors-hydrated";

/** Payload mirror of the Rust `AiVectorsHydrated` — bounded counters only. */
interface AiVectorsHydrated {
  embedded: number;
  loaded_from_blob: boolean;
  reembedded: number;
}

export function AiHydrationProbe() {
  const [last, setLast] = useState<AiVectorsHydrated | null>(null);
  // A monotonically-incrementing counter so the E2E can wait for a NEW event
  // after a re-unlock even when the payload happens to be identical.
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // Guard the async `listen()` resolve: if the component unmounts before the
    // subscription is established, store nothing and unlisten immediately —
    // otherwise the listener (and its state-setter closures) leak past unmount.
    let cancelled = false;
    void listen<AiVectorsHydrated>(AI_VECTORS_HYDRATED_EVENT, (e) => {
      if (cancelled) return;
      setLast(e.payload);
      setSeq((n) => n + 1);
    }).then((u) => {
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (last === null) return null;

  return (
    <div
      data-testid="ai.hydration-probe"
      data-embedded={String(last.embedded)}
      data-loaded-from-blob={last.loaded_from_blob ? "true" : "false"}
      data-reembedded={String(last.reembedded)}
      data-seq={String(seq)}
      style={{ display: "none" }}
    />
  );
}
