// Editor-shell sync banners (MYND-426 reconcile + MYND-427 integrity alert).
// A single host placed once in the editor chrome, above the three-pane row.
// Two honest, non-blocking, dismissable signals (PRODUCT.md tone):
//
//  - ReconcileBanner: lit while the engine reports an active sync — a background
//    full-reconcile (410 cursor-expired / soft-retire) shows the reassuring
//    "catching up" notice. Driven by the real `sync_status` poll via
//    `useSyncStatus`, so it stays silent while sync is off (the common case).
//  - IntegrityAlertBanner: lit when the engine's head-verify rejects a rollback
//    / non-extending head (a possible-tamper alert). The MYND-424 engine loop
//    emits `sync://integrity-alert` when that happens; this subscribes to it.
//    Until the loop lands (R3) the seam stays dormant — the same event-driven
//    pattern as the `vault-lock-imminent` listener in Editor.tsx.

import { useEffect, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSyncStatus } from "../../hooks/useSyncStatus";
import { ReconcileBanner } from "./ReconcileBanner";
import { IntegrityAlertBanner } from "./IntegrityAlertBanner";

const STACK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-4) 0",
};

export function SyncBanners() {
  const { status } = useSyncStatus();
  const [reconcileDismissed, setReconcileDismissed] = useState(false);
  const [integrity, setIntegrity] = useState(false);

  const syncing = status?.state === "syncing";

  // Re-arm the reconcile banner for each new sync episode (a fresh "catching
  // up" notice once the next reconcile starts).
  useEffect(() => {
    if (!syncing) setReconcileDismissed(false);
  }, [syncing]);

  // Producer: the MYND-424 engine loop emits `sync://integrity-alert` on a
  // head-verify rejection. Dormant until that lands (R3); no-op outside Tauri.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await listen("sync://integrity-alert", () => {
          if (!cancelled) setIntegrity(true);
        });
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Not inside Tauri (browser dev shim) → no integrity channel.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const showReconcile = syncing && !reconcileDismissed;
  if (!showReconcile && !integrity) return null;

  return (
    <div style={STACK_STYLE}>
      <ReconcileBanner
        active={showReconcile}
        onDismiss={() => setReconcileDismissed(true)}
      />
      <IntegrityAlertBanner
        present={integrity}
        onDismiss={() => setIntegrity(false)}
      />
    </div>
  );
}
