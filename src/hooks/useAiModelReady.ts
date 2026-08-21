// What an AI surface should say about a feature, read ONCE from the host's own
// capability report (local-ai epic MYND-408; rewritten by ai-backend-degradation
// myne#191 task 1).
//
// It used to issue its own `get_model_path` probe for the generation role and
// `catch` to `false`. That was one of five independent guesses at the same
// question, and the collapse they shared is what made every empty state lie:
// "this build has no AI", "you have not chosen a model", "your runtime is not
// answering" and "the command does not exist" all arrived as a single `false`,
// and the surface could only ever say "select a model".
//
// The report is the one source (SYNC-5). It must be host-side regardless of
// preference: the WebView CSP carries no loopback origin, so page context
// physically cannot ask a local runtime anything.

import { useEffect, useState } from "react";

import {
  aiCapabilityReport,
  surfaceStateOf,
  type AiFeature,
  type AiSurfaceState,
} from "../lib/ai-capability";

const CHECKING: AiSurfaceState = { kind: "checking" };

/**
 * The state of one AI `feature`, or `checking` while the single host read is in
 * flight. Only reads when `enabled` — a surface behind a disabled opt-in needs
 * no answer, and stays `checking` rather than claiming a state it never asked
 * about.
 *
 * No `catch` arm here, and that is not an oversight: `aiCapabilityReport`
 * already answers a rejected invoke with the uncompiled report, because a
 * missing command is the one thing that can only mean "not compiled in". Adding
 * a `catch → unavailable` on top would re-introduce the conflation this hook
 * was rewritten to remove.
 */
/**
 * Which backend class is actually serving, or `null` while unasked.
 *
 * **The host's verdict, never the preference**, which is the whole reason this
 * exists as a hook rather than a `prefs.ai_provider` read at the call site.
 * `LocalInferenceState::active()` checks seven things and falls back to the
 * local arm the moment any one fails; naming a provider satisfies one of them.
 * A surface that attributes an answer, or states where the model runs, has to
 * name what happened rather than what was intended (myne-md/myne#466,
 * `decisions.md` 2026-08-13). `AiPanel` already derives its caption this way;
 * this is the same derivation for the surfaces outside Settings.
 */
export function useAiBackendClass(enabled: boolean): string | null {
  const [backendClass, setBackendClass] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setBackendClass(null);
      return;
    }
    let cancelled = false;
    void aiCapabilityReport().then((report) => {
      if (!cancelled) setBackendClass(report.backendClass);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return backendClass;
}

export function useAiSurfaceState(
  enabled: boolean,
  feature: AiFeature = "generation",
): AiSurfaceState {
  const [state, setState] = useState<AiSurfaceState>(CHECKING);

  useEffect(() => {
    if (!enabled) {
      setState(CHECKING);
      return;
    }
    let cancelled = false;
    void aiCapabilityReport().then((report) => {
      if (!cancelled) setState(surfaceStateOf(report, feature));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, feature]);

  return state;
}
