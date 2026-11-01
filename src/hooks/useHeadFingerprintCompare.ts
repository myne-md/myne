// The SYNC-40 device-verification eye-compare, as one hook (myne-md/myne#462).
//
// # Why this exists as a hook rather than four copies
//
// It was four copies. `DeviceManagementPanel` (the approving side) and two
// joining screens (the desktop join modal and the browser bootstrap, both since
// deleted by `decisions/sync/0767`) each hand-rolled the same self-scheduling
// tick, and `mobile/` had two more. The
// copies drifted, and the drift is the bug: the mobile approving side never
// received the poll #243 added to the desktop one, so it kept the pre-#243
// shape — a single one-shot read — for months, untested, while the desktop
// screen it mirrors was fixed.
//
// # The defect this hook is written against
//
// The compare shows `head_fingerprint(head_id)`, and a head is not a stable
// identity: every push authors a new one. All four copies **latched on the
// first non-null answer**, and they reached it at very different moments. A
// joining device's `vv_log` starts empty, so its first non-null answer is the
// head it adopted — correct, and what `sync-protocol.md` §6.3 prescribes. An
// approving device is already enrolled, so its answer is non-null on the very
// first tick and it latched a head from BEFORE its own sync landed. Then the
// ceremony moved the head under both of them.
//
// Two changes fix it, and neither is sufficient alone:
//
// 1. **The push hold** (`plugin:sync|sync_verify_hold_*`, core-side). While
//    this hook is active the vault head cannot advance, so both sides converge
//    on one value instead of racing. It suppresses the *push*, not the write —
//    a device name typed during the join still lands on disk immediately, which
//    is what keeps MYND-548 fixed.
// 2. **No latch.** The displayed code tracks the head. If it moves anyway — a
//    third device pushed, or the hold lapsed — the screen says so through
//    `changed` rather than either lying (a frozen stale code) or lying quietly
//    (a code that swaps under the reader mid-comparison).
//
// # Why `changed` is announced rather than swallowed
//
// A compare that silently re-converges is a compare that always eventually
// agrees, and "keep looking until they match" is not a comparison — a malicious
// server that forks two devices and later serves them both the same tip would
// pass it. So a moved head is surfaced, and the user is asked to look again on
// purpose. `threat-model.md` §7 records this eye-compare as the *only*
// mitigation for the TOFU-bootstrap hole; it is worth keeping honest.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../platform/core";

/// Which side of the ceremony this screen is.
///
/// It changes **when an alarm is credible**, and nothing else. An approving
/// device is already enrolled, so `sync_head_fingerprint` answers on the very
/// first tick — with the head it held *before* it pulled, which is exactly the
/// stale value #462 is about. That value is then corrected a tick later, and
/// calling THAT correction "the code changed" would fire the alarm on every
/// single approval.
///
/// So for an approver, a change is convergence until its first cycle settles,
/// and an alarm afterwards. A joiner has no such phase: its answer is `null`
/// until it adopts a head, so its first value is already the right one.
///
/// **The correction is never gated on the cycle**, for either role. A `sync_now`
/// that hangs — a large vault, a dead network — must not hide the code; that is
/// the MYND-537 property, and `tests/components/DeviceManagementPanel.test.tsx`
/// pins it with a `sync_now` that never settles. The cycle is fired and watched,
/// never awaited.
export type CompareRole = "approver" | "joiner";

/// About once a second while the compare is on screen. Also the lease ping for
/// the push hold — the core releases the hold after `VERIFY_HOLD_LEASE_MS`
/// (15 s) of silence, so this cadence has ~15 ticks of headroom before a stalled
/// tick lets the head move.
const TICK_MS = 1_000;

/// How long an approver's value may be treated as "still converging" before a
/// change starts counting as an alarm.
///
/// The convergence phase exists because an approver's first read is the head it
/// held BEFORE the approval, and the correction that follows is not news. But
/// the phase has to end on something that always happens: keyed to the first
/// `sync_now` settling, a cycle the server stalls keeps the phase open forever,
/// and with it the alarm disarmed. Ten seconds is far longer than a cycle that
/// is going to complete and far shorter than a human comparing two codes.
const CONVERGENCE_GRACE_MS = 10_000;

export interface HeadFingerprintCompare {
  /// The `XXXX-XXXX` code to show, or `null` while there is nothing to show.
  fingerprint: string | null;
  /// No answer has come back yet. Sub-second — it is cleared by the first
  /// fingerprint read, not by the sync cycle, so a hung cycle cannot pin it.
  syncing: boolean;
  /// The head moved after a code was already on screen. The code shown is the
  /// new one; the user is being told to compare again rather than trust a
  /// reading they took before it changed.
  changed: boolean;
  /// The user has looked again. Clears `changed`; does not re-read anything,
  /// because the poll already holds the current value.
  acknowledgeChange: () => void;
}

export function useHeadFingerprintCompare(
  active: boolean,
  role: CompareRole,
): HeadFingerprintCompare {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  // Seeded from `active`, not `false`. Set only inside the effect, the
  // approver's FIRST committed render had `syncing === false` and
  // `fingerprint === null`, which is the pending branch: a screen zero
  // milliseconds old told the user the code appears once the new device
  // finishes its first sync. The state this replaced was set in the same
  // synchronous update as the screen, so the flash was a regression.
  const [syncing, setSyncing] = useState(active);
  const [changed, setChanged] = useState(false);
  // The last value we showed, read inside the tick without re-arming the effect.
  // Keeping it in a ref rather than the effect's deps is what lets the poll run
  // uninterrupted for the life of the screen: a dep on `fingerprint` would tear
  // the tick down and rebuild it on every answer, which is how the original
  // copies ended up structurally unable to keep polling.
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
    //
    // BOUNDED, and the bound is the security property. `settled` and `cycling`
    // were cleared only in the first `sync_now`'s `.finally()`, and that call is
    // fired without being awaited, so a cycle that never settles left `settled`
    // false for the life of the screen: the alarm at the bottom of this tick
    // could never fire, and `cycling` stayed true so no second cycle was ever
    // started either, which stops the approving device pulling as well.
    //
    // An untrusted server controls that duration by stalling its pull response.
    // It could therefore keep an approver displaying its pre-ceremony head with
    // no alarm and no syncing indication, seat the TOFU joiner on that same
    // real-but-stale head, and the two codes MATCH. That is a false negative in
    // the one comparison `threat-model.md` §7 records as the only mitigation for
    // the TOFU-bootstrap hole, and it is the direction `decisions.md` claims this
    // ceremony cannot fail in.
    //
    // A wall-clock deadline always terminates, so the alarm always arms.
    const armedAt = Date.now();
    const settledByDeadline = () => Date.now() - armedAt >= CONVERGENCE_GRACE_MS;
    let cycleSettled = role !== "approver";
    const isSettled = () => cycleSettled || settledByDeadline();
    setSyncing(true);

    const tick = async () => {
      try {
        // Arm/renew the hold BEFORE anything else in the tick. The core treats
        // repeated calls as the lease ping, and arming first means a slow
        // fingerprint read cannot let the lease expire mid-tick.
        await invoke("plugin:sync|sync_verify_hold_begin");
      } catch {
        /* an unarmed hold degrades to the pre-fix behaviour, never to a stall */
      }
      try {
        // `cycling` is released by the deadline too. Left to the `.finally()`
        // alone, a hung cycle also stopped this screen re-issuing `sync_now`,
        // so the approving device stopped pulling as well as stopped alarming.
        if (cycling && settledByDeadline()) cycling = false;
        if (!cycling) {
          cycling = true;
          // Fired and watched, never awaited — see `CompareRole`. `settled`
          // only decides whether a later change counts as an alarm; it never
          // holds the code back.
          void invoke("plugin:sync|sync_now")
            .catch(() => {
              /* transient — the next tick starts another */
            })
            .finally(() => {
              cycling = false;
              cycleSettled = true;
            });
        }
        const fp = await invoke<string | null>("plugin:sync|sync_head_fingerprint");
        if (!cancelled && fp && fp !== shown.current) {
          // An alarm needs two things: a code was already on screen, and we are
          // past the approver's convergence phase. Otherwise this is the
          // pre-sync head being corrected, which happens on every approval and
          // is not what the user needs to be told about.
          if (shown.current !== null && isSettled()) setChanged(true);
          shown.current = fp;
          setFingerprint(fp);
        }
      } catch {
        /* transient — retry next tick */
      }
      if (!cancelled) {
        setSyncing(false);
        // NO `return` on success. That missing line is the whole bug: a latched
        // side and a moving side can never agree.
        timer = setTimeout(() => void tick(), TICK_MS);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      // Release explicitly. The lease would drop it within 15 s anyway, which is
      // what covers a crashed tab, but holding a device's pushes for 15 s after
      // the user closed the screen is pure cost.
      void invoke("plugin:sync|sync_verify_hold_end").catch(() => {
        /* the lease is the backstop */
      });
    };
  }, [active, role]);

  const acknowledgeChange = useCallback(() => setChanged(false), []);

  return { fingerprint, syncing, changed, acknowledgeChange };
}
