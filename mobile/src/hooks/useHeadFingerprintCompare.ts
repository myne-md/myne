// The mobile twin of `src/hooks/useHeadFingerprintCompare.ts` (myne-md/myne#462).
//
// # Why a twin rather than a shared module
//
// The two trees reach IPC through different seams and neither can import the
// other's: desktop goes through `src/platform/core.ts` (guarded by
// `scripts/check-platform-seam.mjs`), mobile through `mobile/src/lib/sync.ts`.
// Hoisting ~90 lines of polling into a sixth workspace package would cost a
// `package.json`, tsconfig paths and three build aliases to save one file.
//
// So the pair is registered in `scripts/check-twin-drift.mjs` instead, which is
// the mechanism this repo already built for exactly this failure — and this bug
// is why: the mobile approving side never received the poll #243 added to the
// desktop one, so it kept a one-shot read for months while its twin was fixed,
// and nothing anywhere reported the divergence.
//
// **Change one, change the other.** The behaviour contract is stated once, in
// the desktop file's header; this file deliberately does not restate it, because
// two copies of a rationale drift the same way two copies of code do.

import { useCallback, useEffect, useRef, useState } from "react";
import { syncNow, syncHeadFingerprint, syncVerifyHoldBegin, syncVerifyHoldEnd } from "../lib/sync";

export type CompareRole = "approver" | "joiner";

/// About once a second — also the lease ping for the core-side push hold, which
/// releases after 15 s of silence.
const TICK_MS = 1_000;

export interface HeadFingerprintCompare {
  fingerprint: string | null;
  syncing: boolean;
  changed: boolean;
  acknowledgeChange: () => void;
}

export function useHeadFingerprintCompare(
  active: boolean,
  role: CompareRole,
): HeadFingerprintCompare {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [changed, setChanged] = useState(false);
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (!active) {
      setFingerprint(null);
      setChanged(false);
      shown.current = null;
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cycling = false;
    // Has this screen's first sync cycle finished, one way or the other? Until
    // it has, an approver's value is still converging and a change is not news.
    let settled = role !== "approver";
    setSyncing(true);

    const tick = async () => {
      try {
        await syncVerifyHoldBegin();
      } catch {
        /* an unarmed hold degrades to the pre-fix behaviour, never to a stall */
      }
      try {
        if (!cycling) {
          cycling = true;
          // Fired and watched, never awaited. `settled` only decides whether a
          // later change counts as an alarm; it never holds the code back — a
          // hung cycle must not hide the code (the MYND-537 property).
          void syncNow()
            .catch(() => {
              /* transient — the next tick starts another */
            })
            .finally(() => {
              cycling = false;
              settled = true;
            });
        }
        const fp = await syncHeadFingerprint();
        if (!cancelled && fp && fp !== shown.current) {
          if (shown.current !== null && settled) setChanged(true);
          shown.current = fp;
          setFingerprint(fp);
        }
      } catch {
        /* transient — retry next tick */
      }
      if (!cancelled) {
        setSyncing(false);
        timer = setTimeout(() => void tick(), TICK_MS);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      void syncVerifyHoldEnd().catch(() => {
        /* the lease is the backstop */
      });
    };
  }, [active, role]);

  const acknowledgeChange = useCallback(() => setChanged(false), []);

  return { fingerprint, syncing, changed, acknowledgeChange };
}
