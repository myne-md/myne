// Reflects whether the on-device AI has a usable *generation* model side-loaded
// (local-ai epic, ai-ux-surface MYND-408).
//
// AI now ships in the default build and is a runtime beta opt-in (decisions.md
// 2026-07-02), so `ai_enabled` alone no longer implies the engine can produce
// output: the user must ALSO side-load a model file (SYNC-1 — Myne never
// downloads one). Without this signal the AI surfaces would show a misleading
// "AI ready" while every inference silently fails with `NotReady`. This hook
// lets them say "select a model" instead.

import { useEffect, useState } from "react";

import { loadModelPath } from "../lib/ai-model-store";

/**
 * `null` while the (fast, device-local) path check is in flight, `true` once a
 * generation model path is recorded, `false` when none is set. Only probes when
 * `enabled` — a disabled toggle needs no check. Re-runs when `enabled` flips.
 */
export function useAiModelReady(enabled: boolean): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReady(null);
      return;
    }
    let cancelled = false;
    // A missing command (a `--no-default-features` AI-free build) or any error
    // degrades to "not ready" rather than throwing — the surface stays usable.
    loadModelPath("generation")
      .then((path) => {
        if (!cancelled) setReady(path !== null);
      })
      .catch(() => {
        if (!cancelled) setReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return ready;
}
