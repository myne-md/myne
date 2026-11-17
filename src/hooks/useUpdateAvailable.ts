// `useUpdateAvailable`: whether a signed update is on offer, what the notice is
// doing, and the whole install flow (desktop self-update).
//
// One hook owns the flow because the flow does not fit in a component. The
// confirm locks the vault, which moves the Stage off `editor` and unmounts
// whatever the editor was rendering, so the state has to live above the screen
// that started it. It is mounted once, in `App.tsx`, and gated on the stage: the
// automatic check therefore still begins ten seconds after the editor stage is
// entered, exactly as it did when the banner owned it, and the install keeps its
// state across the transition into `updating`.
//
// The order on a confirmed update is load-bearing and lives here rather than at
// the call site: flush the open panes, then lock the vault, then enter the
// stage, then install. The flush is the only step that needs the keys, and it
// has to finish before the lock because a pane's own autosave can be up to ~10s
// behind.
//
// **A refusal in either of those two steps STOPS the flow**, and that is a
// correction rather than a caution. `flushOpenPanes` rejects precisely to keep
// "the flush ran" and "the disk matches the buffer" apart (myne-md/myne#520), and
// the lock is what unmounts the panes and drops the keys, so proceeding past a
// rejected flush destroys exactly the edits the confirmation promised to save.
// Nothing here is an emergency: the user pressed a button, and they can press it
// again. So a refusal sets `blocked`, leaves the stage alone, and the confirm
// says which step refused (`src/components/update/UpdateNotice.tsx`).
//
// Gated on the `selfUpdate` capability: on a client without it (web, mobile) the
// hook is inert and no affordance mounts, rather than offering one against a
// command that refuses.

import { useCallback, useEffect, useRef, useState } from "react";
import { has } from "../platform/capabilities";
import { lockVault } from "../lib/vault-unlock";
import { listen, type UnlistenFn } from "../platform/event";
import {
  getAutoCheck,
  updateCheck,
  updateInstall,
  UPDATE_PROGRESS_EVENT,
  type UpdateProgress,
} from "../platform/update";
import { renameFlushHooks } from "../notes/renameFlushHook";

/** Let the app settle before the first background check competes for the network. */
const INITIAL_DELAY_MS = 10_000;
/** Re-check cadence while the editor stays open. */
const INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * How long the offer holds the middle of the window before it reduces to the
 * pill. Long enough to read the version and notice the consequence line, short
 * enough that an unattended offer is not covering the last lines of the note
 * somebody is reading.
 */
const COLLAPSE_MS = 8_000;

export type UpdateNoticeView = "offer" | "confirm" | "pill";
export type UpdatePhase = "idle" | "working" | "failed";
export type UpdateBlock = "flush" | "lock" | "stage";

/**
 * Where the install has got to, as the screen renders it.
 *
 * `starting` is not a host phase: it is the window between pressing the button
 * and the first tick, during which the host is resolving the manifest and
 * opening the request. It exists so the screen has an honest indeterminate state
 * instead of showing 0% and claiming the download began.
 */
export type UpdateProgressPhase =
  | "starting"
  | UpdateProgress["phase"];

/** A live progress reading, in the shape the screen draws. */
export interface UpdateProgressState {
  phase: UpdateProgressPhase;
  /** Bytes received in this attempt. Meaningful only while downloading. */
  downloaded: number;
  /** The artifact's size, or null when the origin declared none. */
  total: number | null;
}

const NOT_STARTED: UpdateProgressState = {
  phase: "starting",
  downloaded: 0,
  total: null,
};

export interface UseUpdateAvailableOptions {
  /** False outside the stages that can show an update, which gates the check. */
  enabled: boolean;
  /**
   * Entered after the flush and the lock, before the install. This is where the
   * caller dispatches the stage change, because the stage is what unmounts the
   * editor and it has to happen after the flush has written through it.
   *
   * Returns whether the app actually moved into the updating stage. False means
   * the transition was refused because something else left `editor` first, and
   * the install must NOT run: the screen that would report a failure is
   * unreachable from wherever the app is now.
   */
  onLocked: () => boolean;
}

export interface UpdateAvailableHook {
  /** What the notice should show, or `null` for nothing at all. */
  view: UpdateNoticeView | null;
  /** What the updating screen is doing. `idle` until an install starts. */
  phase: UpdatePhase;
  /** Where the install has got to, for the updating screen's bar and readout. */
  progress: UpdateProgressState;
  /** True from the confirm's press until the install resolves. */
  working: boolean;
  /** Which step refused to start the update. Null unless one did. */
  blocked: UpdateBlock | null;
  version: string | null;
  /** Release notes from the manifest, when it carries them. */
  notes: string | null;
  /** The offer's press: expand into the confirm. */
  request: () => void;
  /** The confirm's press, and the retry after a refusal. */
  confirm: () => void;
  /** Back out of the confirm, keeping the offer. */
  cancel: () => void;
  /** Dismiss for the session. The next launch's check offers it again. */
  later: () => void;
  /** Reopen the pill. */
  reopen: () => void;
  /** Re-run the install after a failure. The vault is already locked. */
  retry: () => void;
}

export function useUpdateAvailable({
  enabled,
  onLocked,
}: UseUpdateAvailableOptions): UpdateAvailableHook {
  const [view, setView] = useState<UpdateNoticeView | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [blocked, setBlocked] = useState<UpdateBlock | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [progress, setProgress] = useState<UpdateProgressState>(NOT_STARTED);
  // Session-scoped, and separate from `view` because a re-check must not
  // resurrect an offer the user dismissed.
  const dismissed = useRef(false);
  // Re-entrancy: the confirm disables its own buttons, and this closes the same
  // window for any other caller. Two chains would run two installers against one
  // bundle, which is the one outcome worse than a failed install.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled) {
      // Left the editor: the offer belongs to a session that just ended.
      setView(null);
      return;
    }
    if (!has("selfUpdate")) return;
    let cancelled = false;

    const runIfAuto = () => {
      // The dismissal is read HERE rather than at effect setup, because it is
      // the daily tick that would otherwise resurrect an offer the user put
      // away: `later()` writes a ref, no effect re-runs, and the interval keeps
      // its own closure.
      if (dismissed.current) return;
      getAutoCheck()
        .then((auto) => {
          if (cancelled || !auto) return undefined;
          return updateCheck().then((status) => {
            if (cancelled) return;
            if (status.kind === "available") {
              setVersion(status.version);
              setNotes(status.notes);
              setView("offer");
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
  }, [enabled]);

  // The offer announces itself and then gets out of the way. Only from `offer`:
  // a confirm the user has opened is a decision in progress, and collapsing it
  // would take the decision away mid-read (myne-md/myne#870).
  useEffect(() => {
    if (view !== "offer") return;
    const timer = setTimeout(() => setView("pill"), COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [view]);

  // The install's own progress stream (myne-md/myne#1020). Subscribed for the session
  // rather than around each install for one reason: `listen` resolves
  // asynchronously, and a subscription taken at the press would race the first
  // chunks, which is a bar that starts at 8% for no reason. Nothing emits this
  // outside an install, and a ticket arriving while the screen is not showing is
  // a value nothing renders.
  useEffect(() => {
    if (!has("selfUpdate")) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    listen<UpdateProgress>(UPDATE_PROGRESS_EVENT, (event) => {
      const tick = event.payload;
      if (tick.phase === "downloading") {
        setProgress((prev) => {
          // NEVER BACKWARDS (myne-md/myne#1059): two installs used to emit on
          // this one event name and the renderer took whichever arrived last,
          // so the bar ran forwards and back at once. The host refuses a second
          // install now; a readout that cannot regress is still the property
          // this screen is supposed to have on its own.
          const floor = prev.phase === "downloading" ? prev.downloaded : 0;
          return {
            phase: "downloading",
            downloaded: Math.max(floor, tick.downloaded),
            // A tick with no total does not erase one an earlier tick measured.
            total: tick.total ?? prev.total,
          };
        });
      } else {
        // The byte counts stay from the last tick: the screen shows a full bar
        // for these phases, and keeping the numbers lets a later `downloading`
        // (a retry) start from what the host actually reported.
        setProgress((prev) => ({ ...prev, phase: tick.phase }));
      }
    })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch((error: unknown) => {
        // No event stream is not a failed install: the bar simply stays in its
        // starting shape while the install runs to its own conclusion.
        if (import.meta.env.DEV) {
          console.warn("useUpdateAvailable: progress subscription failed", error);
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const install = useCallback(() => {
    setPhase("working");
    setProgress(NOT_STARTED);
    updateInstall()
      .catch(() => {
        // A failed install leaves the running version untouched, so this is the
        // calm failure line rather than an error dialog.
        setPhase("failed");
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  const confirm = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBlocked(null);
    setPhase("working");
    void (async () => {
      // The flush must be awaited BEFORE the lock: it writes through the panes
      // the editor owns, and the lock is what unmounts them. A rejection here
      // means at least one pane did not reach disk, so the flow stops with the
      // panes still mounted and their buffers still recoverable.
      try {
        await renameFlushHooks().flushOpenPanes();
      } catch {
        setPhase("idle");
        setBlocked("flush");
        inFlight.current = false;
        return;
      }
      try {
        await lockVault();
      } catch {
        // The confirmation promised a locked vault, so a vault that would not
        // lock means no install. The stage is untouched, so the notice is still
        // on screen to say which step refused.
        setPhase("idle");
        setBlocked("lock");
        inFlight.current = false;
        return;
      }
      const moved = onLocked();
      if (!moved) {
        // The caller refused the stage transition, which means the app is no
        // longer on `editor` (an idle lock or a vault switch landed during the
        // flush). There is no updating screen to put an install on, so the flow
        // stops and the confirm says so instead of installing against another
        // screen where no failure could be reported.
        setPhase("idle");
        setBlocked("stage");
        inFlight.current = false;
        return;
      }
      install();
    })();
  }, [install, onLocked]);

  return {
    view,
    phase,
    progress,
    working: phase === "working",
    blocked,
    version,
    notes,
    request: useCallback(() => {
      setBlocked(null);
      setView("confirm");
    }, []),
    confirm,
    cancel: useCallback(() => {
      setBlocked(null);
      setView("offer");
    }, []),
    later: useCallback(() => {
      dismissed.current = true;
      setView(null);
    }, []),
    reopen: useCallback(() => setView("offer"), []),
    retry: install,
  };
}
