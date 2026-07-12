// Editor-shell sync banners (MYND-426 reconcile + MYND-427 integrity alert).
// A single host placed once in the editor chrome, above the three-pane row.
// Two honest, non-blocking, dismissable signals (PRODUCT.md tone):
//
//  - ReconcileBanner: shown when the engine performs a background full-reconcile
//    (410 cursor-expired / soft-retire) — the reassuring "catching up" notice.
//    Driven by the DISTINCT `sync://reconcile-started`/`-finished` events
//    (MYND-461), NOT the coarse `syncing` state, so it shows only during an
//    actual reconcile — not on every ordinary sync tick — and stays silent while
//    sync is off (the common case).
//  - IntegrityAlertBanner: lit when the engine's head-verify rejects a rollback
//    / non-extending head (a possible-tamper alert). `run_active_cycle` emits
//    `sync://integrity-alert` when that happens (MYND-461); this subscribes to it.

import { useEffect, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { ReconcileBanner } from "./ReconcileBanner";
import { IntegrityAlertBanner } from "./IntegrityAlertBanner";

const STACK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-4) 0",
};

export function SyncBanners() {
  const [reconcileActive, setReconcileActive] = useState(false);
  const [reconcileDismissed, setReconcileDismissed] = useState(false);
  const [integrity, setIntegrity] = useState(false);

  // Event-driven producers (MYND-461). A reconcile occurred → show the reassuring
  // banner, re-armed, until the user dismisses it. A head-verify rejection → the
  // integrity alert. No-op outside Tauri (browser dev shim).
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const sub = async (ev: string, fn: () => void) => {
      try {
        const handle = await listen(ev, () => {
          if (!cancelled) fn();
        });
        if (cancelled) handle();
        else unlisteners.push(handle);
      } catch {
        // Not inside Tauri → no event channel.
      }
    };
    const armReconcile = () => {
      setReconcileActive(true);
      setReconcileDismissed(false);
    };
    void sub("sync://reconcile-started", armReconcile);
    void sub("sync://reconcile-finished", armReconcile);
    void sub("sync://integrity-alert", () => setIntegrity(true));
    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
    };
  }, []);

  const showReconcile = reconcileActive && !reconcileDismissed;
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
