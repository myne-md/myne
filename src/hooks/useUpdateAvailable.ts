// `useUpdateAvailable`: whether a signed update is available, and the
// automatic check policy (desktop self-update).
//
// Where the automatic check is what the user can turn off, the toggle is
// device-local (`plugin:update|update_get_auto_check`), and the policy is:
// one check a short delay after the editor mounts, then every 24 hours while it
// stays mounted. The manual "Check for updates" in Settings is a SEPARATE path
// and runs regardless of the toggle.
//
// Gated on the `selfUpdate` capability: on a client without it (web) the hook
// is inert and the affordance is absent rather than shown broken.

import { useCallback, useEffect, useState } from "react";
import { has } from "../platform/capabilities";
import { getAutoCheck, updateCheck, updateInstall } from "../platform/update";
import { renameFlushHooks } from "../notes/renameFlushHook";

/** Let the app settle before the first background check competes for the network. */
const INITIAL_DELAY_MS = 10_000;
/** Re-check cadence while the editor stays open. */
const INTERVAL_MS = 24 * 60 * 60 * 1000;

export type UpdateState =
  | { state: "idle" }
  | { state: "available"; version: string }
  | { state: "installing" }
  | { state: "failed" };

export interface UpdateAvailableHook {
  state: UpdateState;
  /** Download, install and relaunch into the offered update. */
  install: () => void;
}

export function useUpdateAvailable(): UpdateAvailableHook {
  const [state, setState] = useState<UpdateState>({ state: "idle" });

  useEffect(() => {
    if (!has("selfUpdate")) return;
    let cancelled = false;

    const runIfAuto = () => {
      getAutoCheck()
        .then((auto) => {
          if (cancelled || !auto) return undefined;
          return updateCheck().then((status) => {
            if (cancelled) return;
            if (status.kind === "available") {
              setState({ state: "available", version: status.version });
            }
          });
        })
        .catch(() => {
          // A failed read or check is silent; offline is the ordinary transient
          // case and the next tick retries.
        });
    };

    const initial = setTimeout(runIfAuto, INITIAL_DELAY_MS);
    const interval = setInterval(runIfAuto, INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);

  const install = useCallback(() => {
    setState({ state: "installing" });
    void (async () => {
      // Flush unsaved note edits before the process exits to install, the same
      // way every other exit path (close, lock) does. The install relaunches the
      // app, and a pane's own autosave can be up to ~10s behind.
      try {
        await renameFlushHooks().flushOpenPanes();
      } catch {
        // Best effort: a failed flush must not block a security update.
      }
      updateInstall().catch(() => {
        // A failed install leaves the running version untouched; fall back to
        // the calm failure line rather than an error dialog.
        setState({ state: "failed" });
      });
    })();
  }, []);

  return { state, install };
}
