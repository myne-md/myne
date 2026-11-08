// `usePrefValue` — ONE owner for "read one pref, write it optimistically, and tell
// the user when the write did not land" (myne-md/myne#995).
//
// # The failure this removes
//
// Sixteen settings surfaces in `src/components/settings/` each hand-wrote the same
// three-step dance: a `useState` default, a mount `prefsRead()` with a `cancelled`
// flag, and a write that flipped local state, persisted, and reverted on rejection.
// `src/lib/prefs.ts` exports 68 per-pref setters and `src/hooks/usePrefs.ts` owns the
// whole-view cache, so the owner of the READ half and the owner of the WRITE half both
// existed — what did not exist was the join, so every new setting had to invent its
// own rollback. `mobile/src/lib/use-prefs.ts` answered the read half a second time
// for the phone, which is the shape a shared owner prevents.
//
// # Why it lives in `client-core`
//
// Both clients ask this question and it touches no host: `read`, `select` and `write`
// are all injected, which is `client-core`'s entry criterion (`decisions/clients/0716`
// extending `0580`). The desktop passes its `prefsRead`/setter pair, the phone passes
// its own, and the state machine below is written once.
//
// # Failure converges on DISK TRUTH, not on a captured previous value
//
// The blocks this replaces rolled back to the value captured before the write. That
// is wrong under concurrency and the wrongness is measured rather than theoretical,
// which is why `src/hooks/usePrefs.ts` already stopped doing it: two rapid toggles
// capture the same baseline, the first write fails, and rolling back to a baseline
// that the SECOND write has already superseded inverts the switch against disk. So a
// rejected write re-reads and applies whatever the vault actually says. If even that
// read fails (a locked vault mid-session), the optimistic value stays: a control that
// moved is a better lie than one that snaps back to a value nobody verified.
//
// One hook is one pref, so a panel with two prefs reads twice instead of once. That
// is deliberate: the read is a small decrypt, and the alternative — a shared view
// cache that many panels subscribe to — is `src/hooks/usePrefs.ts`'s job on the
// desktop and `mobile/src/lib/use-prefs.ts`'s on the phone, not this hook's. Sharing
// it here would make this file a second cache, which is the shape it exists to end.
//
// The mount read failing is NOT an error state. Panels open against a locked or
// absent vault — that is a normal frame, they keep the default every caller already
// chose, and only a failed WRITE is worth a message.

import { useCallback, useEffect, useRef, useState } from "react";

export interface PrefValue<T> {
  /** The current value: the default until the first read lands, then disk's answer. */
  value: T;
  /** Apply optimistically, persist, and converge on disk truth if the write is refused. */
  set: (next: T) => Promise<void>;
  /** The message for the LAST failed write, or `null`. Cleared by the next success. */
  error: string | null;
}

export interface PrefValueOptions<View, T> {
  /** Re-read the source of truth. Called on mount and after a refused write. */
  read: () => Promise<View>;
  /** Pick this pref out of whatever the read returns (a `PrefsView`, or a narrower view). */
  select: (view: View) => T;
  /** Persist. A rejection means the value did not land; anything it throws is swallowed. */
  write: (next: T) => Promise<unknown>;
  /** What the value is before the first read resolves, and if the read never succeeds. */
  initial: T;
  /**
   * The user-facing message for a refused write, already translated by the caller.
   * Omitted by a surface that shows no message at all (the two customize panels):
   * the refusal then converges the value and leaves `error` null, which is exactly
   * what those blocks did with their bare `.catch(() => setOrder(prev))`.
   */
  errorMessage?: string;
}

export function usePrefValue<View, T>({
  read,
  select,
  write,
  initial,
  errorMessage,
}: PrefValueOptions<View, T>): PrefValue<T> {
  const [value, setValue] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);

  // The read on mount is ordered against unmount and against nothing else; a
  // concurrent `set` needs no ordering here because a failed write's own re-read
  // is the later call and therefore the one that wins. `latest` exists so the
  // convergence re-read applies disk truth to a surface whose `select` closure
  // changed identity since mount, without re-running the mount effect.
  const latest = useRef({ read, select });
  latest.current = { read, select };

  useEffect(() => {
    let cancelled = false;
    void latest.current
      .read()
      .then((view) => {
        if (!cancelled) setValue(latest.current.select(view));
      })
      .catch(() => {
        /* locked / no vault: keep the caller's default, which is the documented one */
      });
    return () => {
      cancelled = true;
    };
    // Mount only. A pref is re-read after a WRITE, not after a re-render: a surface
    // that wants to notice a sibling's write uses the prefs nonce (desktop
    // `usePrefs`, mobile `use-prefs`) rather than this hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback(
    async (next: T) => {
      setValue(next);
      try {
        await write(next);
        setError(null);
      } catch {
        try {
          const view = await latest.current.read();
          setValue(latest.current.select(view));
        } catch {
          /* re-read failed too — keep the optimistic value, the write's own error stands */
        }
        setError(errorMessage ?? null);
      }
    },
    [write, errorMessage],
  );

  return { value, set, error };
}
