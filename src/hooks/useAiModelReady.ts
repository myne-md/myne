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

import { loadModelPath, type ModelRole } from "../lib/ai-model-store";

/**
 * `null` while the (fast, device-local) path check is in flight, `true` once a
 * model path for `role` is recorded, `false` when none is set. Only probes when
 * `enabled` — a disabled toggle needs no check. Re-runs when `enabled`/`role`
 * flips. `role` defaults to `"generation"` (the chat/writing surfaces), and that
 * is the only role any caller uses today: the AI-chat header (`AiChatTab`) is
 * the sole consumer. Transcription readiness is NOT handled here — speech-to-text
 * ships a bundled default model (MYND-270) and gates on `transcription_enabled`,
 * so its surfaces react to the backend cause (MYND-591) rather than probing a
 * side-loaded path. The generic `role` param is retained for future callers.
 */
export function useAiModelReady(
  enabled: boolean,
  role: ModelRole = "generation",
): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReady(null);
      return;
    }
    let cancelled = false;
    // A missing command (a `--no-default-features` AI-free build) or any error
    // degrades to "not ready" rather than throwing — the surface stays usable.
    loadModelPath(role)
      .then((path) => {
        if (!cancelled) setReady(path !== null);
      })
      .catch(() => {
        if (!cancelled) setReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, role]);

  return ready;
}
