// SPDX-License-Identifier: AGPL-3.0
//
// The device-to-person binding view for the Sync panel (myne-md/myne#852).
// Reads `vault.device-bindings` through the two commands in
// `src/lib/deviceBindings.ts` and re-reads when a sync cycle lands, so a device
// that claims itself on another machine appears here without reopening Settings.
//
// **A vault that is not shared is a STATE and not an error.** The family is
// `NTV6`-only: a pre-B2B vault has no group key to seal a member-writable
// binding map under, and no members to bind a device to, so the backend answers
// `NotASharedVault`. That sets `shared` false and leaves `error` null, and a
// panel on an unshared vault renders the roster panel's own "not shared yet"
// notice rather than a failure line over a state the user did not cause
// (`useRoster` draws the same distinction for the same vault).
//
// **Why `sync://changed` and not a poll.** The map is a shared singleton: the
// interesting change is always a row written on ANOTHER device and pulled by a
// sync cycle, which is exactly what emits this event. `useDevices` polls its own
// roster every 2 s because enrollment is a handshake the user is watching in
// real time; nothing here is waiting on a handshake, so an interval would be
// pure noise. The ref-held handler + one-shot subscription is
// `useConflictMaterializer`'s pattern: subscribing on every render opens a deaf
// window between `unlisten()` and the next subscription settling.

import { useCallback, useEffect, useState } from "react";
import {
  claimOwnDeviceBinding,
  deviceBindingErrorKey,
  deviceBindingErrorKind,
  listDeviceBindings,
  type DeviceAttributionView,
} from "../lib/deviceBindings";
import { subscribeToEvents } from "../lib/subscribe";

export interface DeviceBindingsHook {
  /** The verified rows and the unverified ids, or `null` before the first read
   *  resolves or after one that failed. */
  view: DeviceAttributionView | null;
  loading: boolean;
  /** The i18n key of the last LOAD or CLAIM failure, or `null`. A non-shared
   *  vault sets `shared` false instead of filling this in. */
  error: string | null;
  /** Whether this vault carries the B2B group tier. False while the first read
   *  is in flight, on an `NTV5` vault, and after any failure, so a panel that
   *  gates on it renders nothing rather than an empty list. */
  shared: boolean;
  claiming: boolean;
  refresh: () => void;
  /** Re-register this device's own binding, then re-read the view. A failure's
   *  i18n key lands in `error`. */
  claimSelf: () => Promise<void>;
}

export function useDeviceBindings(): DeviceBindingsHook {
  const [view, setView] = useState<DeviceAttributionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listDeviceBindings()
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setShared(true);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setView(null);
        if (deviceBindingErrorKind(failure) === "NotASharedVault") {
          setShared(false);
          setError(null);
        } else {
          setError(deviceBindingErrorKey(failure));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // A row written on another device arrives with a sync pull. Subscribed once,
  // with an empty dep list: a per-render subscription opens a deaf window
  // between `unlisten()` and the next subscription settling, which is where a
  // `sync://changed` would be dropped (`useConflictMaterializer` records the
  // same trap). `setTick` is stable, so the closure needs no ref.
  useEffect(
    () => subscribeToEvents(["sync://changed"], () => setTick((t) => t + 1)),
    [],
  );

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const claimSelf = useCallback(async () => {
    setClaiming(true);
    setError(null);
    try {
      const next = await claimOwnDeviceBinding();
      setView(next);
      setShared(true);
    } catch (failure: unknown) {
      setError(deviceBindingErrorKey(failure));
    } finally {
      setClaiming(false);
    }
  }, []);

  return { view, loading, error, shared, claiming, refresh, claimSelf };
}
