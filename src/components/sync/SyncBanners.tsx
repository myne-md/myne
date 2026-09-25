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
//  - TorStatusBanner: Tor mode is on and the tunnel is either coming up or
//    down (MYND-650 task 8). The fail-closed half is the load-bearing one —
//    the transport refuses to connect at all rather than falling back to a
//    direct connection, so without this strip a paused sync is silent. Absent
//    the `torRouting` capability the posture is `null` and nothing renders.
//  - RekeyedElsewhereBanner: the vault was migrated to v0.2 on ANOTHER device
//    (myne-md/myne#429). The engine emits `sync://vault-rekeyed` and locks the
//    vault at the cycle boundary, so this strip exists to explain a lock the
//    user did not ask for. NOT dismissable, for the same reason as the one
//    below: the session is already locked and the only way forward is to unlock
//    again, so hiding the sentence would leave an unexplained lock screen.
//  - StaleSyncBanner: sync has been failing continuously for longer than
//    `SYNC_STALE_DAYS` (myne-md/myne#583). Every other strip here is a
//    single EVENT; this one is a DURATION, and it exists because a duration is
//    what nobody noticed. Sync against the hosted server was dead for four days
//    in August 2026 while the status dot said "Sync error" the whole time — in
//    Settings → Sync, which nobody opens while their notes look like they are
//    saving. They were saving, locally, to one disk. Dismissable but re-armed
//    on the next stale read, because the condition is real until sync works
//    again and a permanent dismiss would restore the silence.
//  - CredentialAmbiguousBanner: the meta phase refused to adopt the server's
//    `vault.meta` because the password-side wraps differ and no baseline says
//    which side moved (phase3-web-client task 88). NOT dismissable, unlike the
//    other two: refusing is a permanent stall — every later cycle re-refuses —
//    so dismissing it would restore exactly the silence the refusal exists to
//    break.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "../../platform/event";
import { ReconcileBanner } from "./ReconcileBanner";
import { IntegrityAlertBanner } from "./IntegrityAlertBanner";
import { TorStatusBanner } from "./TorStatusBanner";
import { useMaterialisationProgress } from "../../hooks/useMaterialisationProgress";
import { useTorState } from "../../hooks/useTorState";
import { useSyncStatus } from "../../hooks/useSyncStatus";
import { isSyncStale } from "../../lib/sync-staleness";
import { resetPersonIdentityState } from "./personIdentityState";

const STACK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-4) 0",
};

export function SyncBanners() {
  const { t } = useTranslation();
  const [reconcileActive, setReconcileActive] = useState(false);
  const [reconcileDismissed, setReconcileDismissed] = useState(false);
  const [integrity, setIntegrity] = useState(false);
  const [credentialAmbiguous, setCredentialAmbiguous] = useState(false);
  const [rekeyedElsewhere, setRekeyedElsewhere] = useState(false);
  // First-sync materialisation (task 39). Counts, never a percentage or an ETA:
  // the measured cost spans 6× across engines at the same note count, so an ETA
  // would be wrong by that factor on whichever browser the user is running.
  const materialising = useMaterialisationProgress();
  // MYND-650 task 8. `null` on web (no `torRouting` capability) and on every
  // desktop install until the first read resolves; only `connecting` and
  // `unavailable` render anything.
  const { posture: torPosture } = useTorState();

  // The one strip driven by a DURATION rather than an event. `useSyncStatus`
  // already polls, and the clock rides on the error status itself, so this adds
  // no IPC of its own. `Date.now()` is read at render rather than held in state
  // deliberately: the poll re-renders this component every few seconds, and a
  // stored "now" is a clock that has to be invalidated by something.
  const { status: liveStatus } = useSyncStatus();
  const [staleDismissed, setStaleDismissed] = useState(false);
  const syncStale =
    liveStatus?.state === "error" &&
    isSyncStale(liveStatus.last_success_at, Date.now());
  // Re-arm once sync recovers, so a dismiss covers this outage and not the next.
  useEffect(() => {
    if (!syncStale) setStaleDismissed(false);
  }, [syncStale]);
  const showStale = syncStale && !staleDismissed;

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
    void sub("sync://credential-ambiguous", () => setCredentialAmbiguous(true));
    void sub("sync://vault-rekeyed", () => {
      resetPersonIdentityState();
      setRekeyedElsewhere(true);
    });
    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
    };
  }, []);

  const showReconcile = reconcileActive && !reconcileDismissed;
  const showMaterialising = materialising !== null && materialising.active;
  const showTor = torPosture === "connecting" || torPosture === "unavailable";
  if (
    !showReconcile &&
    !integrity &&
    !credentialAmbiguous &&
    !rekeyedElsewhere &&
    !showMaterialising &&
    !showTor &&
    !showStale
  ) {
    return null;
  }

  return (
    <div style={STACK_STYLE}>
      {/* First in the stack: it is the only banner here that means nothing is
          leaving the device at all. */}
      <TorStatusBanner posture={torPosture} />
      <ReconcileBanner
        active={showReconcile}
        onDismiss={() => setReconcileDismissed(true)}
      />
      <IntegrityAlertBanner
        present={integrity}
        onDismiss={() => setIntegrity(false)}
      />
      {showStale && (
        // `role="alert"`: unlike the progress strips above, this one is telling
        // the user something is wrong right now and has been for days.
        <div
          role="alert"
          data-testid="sync.stale-warning"
          style={{
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "baseline",
            padding: "var(--space-3) var(--space-4)",
            borderRadius: "var(--radius-2)",
            border: "1px solid var(--warning)",
            background: "var(--bg-2)",
            color: "var(--fg-1)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
          }}
        >
          {/* No date, no elapsed count — AS15 keeps per-device sync clocks off
              screen, and the stored timestamp exists to answer the threshold
              rather than to be rendered. */}
          <span style={{ flex: 1 }}>{t("sync.stale.body")}</span>
          <button
            type="button"
            onClick={() => setStaleDismissed(true)}
            data-testid="sync.stale-dismiss"
            style={{
              background: "none",
              border: "none",
              color: "var(--fg-3)",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-sm)",
              padding: 0,
            }}
          >
            {t("sync.stale.dismiss")}
          </button>
        </div>
      )}
      {showMaterialising && materialising !== null && (
        // `role="status"`, not `alert`: this is progress, not a problem, and an
        // assertive live region would interrupt a screen reader every 250 ms.
        <div
          role="status"
          data-testid="sync.materialising"
          data-done={materialising.done}
          data-total={materialising.total}
          style={{
            display: "flex",
            gap: "var(--space-2)",
            padding: "var(--space-3) var(--space-4)",
            borderRadius: "var(--radius-2)",
            border: "1px solid var(--line-1)",
            background: "var(--bg-2)",
            color: "var(--fg-2)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
          }}
        >
          <span>
            {t("sync.materialising", {
              done: materialising.done,
              total: materialising.total,
            })}
          </span>
        </div>
      )}
      {credentialAmbiguous && (
        // No `onDismiss`, deliberately. The condition does not resolve on its
        // own and every later cycle re-refuses, so a dismiss button would let
        // the user restore the silence this banner exists to break — on the one
        // client (web) where the recovery phrase is not a backstop.
        <div
          role="alert"
          data-testid="sync.credential-ambiguous"
          style={{
            display: "flex",
            gap: "var(--space-2)",
            padding: "var(--space-3) var(--space-4)",
            borderRadius: "var(--radius-2)",
            border: "1px solid var(--warning)",
            background: "var(--bg-2)",
            color: "var(--fg-1)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
          }}
        >
          <span>{t("sync.credentialAmbiguous")}</span>
        </div>
      )}
      {rekeyedElsewhere && (
        // Informational, not an alarm: nothing went wrong and nothing was lost.
        // The user (or their other device) upgraded this vault's format, and
        // this session's keys are simply the previous generation's.
        <div
          role="status"
          data-testid="sync.vault-rekeyed"
          style={{
            display: "flex",
            gap: "var(--space-2)",
            padding: "var(--space-3) var(--space-4)",
            borderRadius: "var(--radius-2)",
            border: "1px solid var(--line-1)",
            background: "var(--bg-2)",
            color: "var(--fg-1)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
          }}
        >
          <span>{t("sync.vaultRekeyed")}</span>
        </div>
      )}
    </div>
  );
}
