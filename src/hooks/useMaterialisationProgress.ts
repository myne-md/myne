// First-sync materialisation progress (phase3-web-client task 39).
//
// # Counts, never a percentage or an ETA
//
// The measured cost of materialising a vault is ~1.9 s / 4.1 s / 9.4 s for
// 3 000 notes on Safari / Chrome / Firefox, and 4.8 s / 12.6 s / 29.9 s at
// 10 000 — a **6× spread across engines at the same note count**. An ETA derived
// from elapsed time would be wrong by that factor on whichever browser the user
// happens to be running, and a progress bar that lies is worse than a count that
// is merely coarse. `done` / `total` are facts.
//
// # Why polling, and why a short beat is affordable
//
// The command is three atomic loads: no lock, no IO, no await past the Worker
// round trip. That is what makes a 250 ms beat reasonable here where a 5 s beat
// is right for the status dot — and a coarser beat would make a 2 s
// materialisation look like a single jump from nothing to done, which is exactly
// the spinner this replaces.
//
// # The generation, and what it prevents
//
// A reading of `0 of 0` is ambiguous: nothing to do, or a run that just ended?
// `generation` increments once per run that materialises anything, so the hook
// can tell a NEW run from a stale reading whose counts happen to match — and so
// a UI can keep the completed state on screen for a moment instead of snapping
// to empty the instant the last note lands.

import { useEffect, useRef, useState } from "react";
import { invoke } from "../platform/core";

/** Mirrors the Rust `MaterialisationProgress`. */
export interface MaterialisationProgress {
  done: number;
  total: number;
  generation: number;
  active: boolean;
}

/** Poll beat while a run is in flight. */
const ACTIVE_MS = 250;
/** Poll beat while idle — a first sync is rare, so idle cost stays near zero. */
const IDLE_MS = 3000;

export function useMaterialisationProgress(): MaterialisationProgress | null {
  const [progress, setProgress] = useState<MaterialisationProgress | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = false;
    const tick = () => {
      invoke<MaterialisationProgress>("plugin:sync|sync_materialisation_progress")
        .then((p) => {
          if (!mounted.current) return;
          setProgress(p);
          active = p.active;
        })
        .catch(() => {
          // A failed read is not evidence of anything; keep the last reading and
          // try again on the idle beat rather than clearing a bar mid-run.
          active = false;
        })
        .finally(() => {
          // Self-scheduling rather than `setInterval`, so a slow round trip
          // never overlaps ticks — and so the beat can change with the state.
          if (mounted.current) timer = setTimeout(tick, active ? ACTIVE_MS : IDLE_MS);
        });
    };
    tick();
    return () => {
      mounted.current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  return progress;
}
