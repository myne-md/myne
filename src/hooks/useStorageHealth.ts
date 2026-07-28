// `useStorageHealth` — did the local copy go away underneath this session?
// (phase3-web-client task 22)
//
// # Why a poll and not an error handler
//
// The obvious place to notice an eviction is the first read that fails. That
// place is everywhere: every note load, every autosave, every singleton flush,
// each with its own error path, and the ones that swallow failures (the search
// rebuild, the graph cache) would notice nothing at all. Threading a shared
// verdict through all of them is a larger change than this, and it would still
// only fire when the user happened to touch storage.
//
// A cheap periodic probe answers the same question in one place: a slot peek, an
// `exists`, and a 345-byte read. No key material, no write, no network.
//
// # Cadence
//
// 30 s, and the choice is a tradeoff worth stating. Faster would notice sooner
// and would also mean a storage syscall every few seconds for a condition that
// is rare and, once it happens, permanent — it does not un-happen while the user
// waits. Slower would leave someone typing into a vault that no longer exists.
// The probe also runs immediately on mount and on the page becoming visible
// again, which is when a browser is most likely to have evicted while the tab
// was backgrounded.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../platform/core";

/** Mirrors the Rust `StorageHealth`. */
export type StorageHealth =
  | { state: "healthy" }
  | { state: "not_unlocked" }
  | { state: "evicted" }
  | { state: "unopenable" }
  | { state: "unknown"; io_error_kind: string };

/** How often to re-probe while a session is live. */
const POLL_MS = 30_000;

export interface StorageHealthHook {
  /** `null` until the first probe resolves. */
  health: StorageHealth | null;
  /**
   * True once the local copy is gone or unusable — the two states that end a
   * session. Sticky: once observed it stays true even if a later probe
   * disagrees, because the alternative is a screen that flickers away while the
   * user is reading why their vault vanished.
   */
  lost: boolean;
  /** Force a probe (e.g. right after a write failed). */
  refresh: () => void;
}

export function useStorageHealth(): StorageHealthHook {
  const [health, setHealth] = useState<StorageHealth | null>(null);
  const [lost, setLost] = useState(false);
  const mounted = useRef(true);

  const tick = useCallback(() => {
    invoke<StorageHealth>("plugin:vault-unlock|vault_storage_health")
      .then((h) => {
        if (!mounted.current) return;
        setHealth(h);
        if (h.state === "evicted" || h.state === "unopenable") setLost(true);
      })
      .catch(() => {
        // A failed probe is NOT evidence of eviction — it is evidence that the
        // probe failed, which on this client most often means the Worker is
        // busy. Erasing a vault on the strength of an unanswered call is the one
        // mistake this whole feature must not make.
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    tick();
    const timer = setInterval(tick, POLL_MS);
    // A browser evicts under storage pressure, and a backgrounded tab is the
    // likeliest victim — so the moment it comes back is the moment to look.
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") tick();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      mounted.current = false;
      clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [tick]);

  return { health, lost, refresh: tick };
}
