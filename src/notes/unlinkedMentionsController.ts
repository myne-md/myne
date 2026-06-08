// On-demand trigger + two-tier nonce behavior for the unlinked-mentions section
// (knowledge-graph-ux #2 / MYND-196, SYNC-14 cost classification). Unlinked-
// mentions is the SYNC-14 "expensive-decrypt" consumer: surfacing a mention
// requires decrypting candidate bodies (`findUnlinkedMentions`), so — unlike the
// decrypt-free backlinks pane — it MUST NOT recompute on every vault-change
// nonce. This pure reducer is that cost gate, kept out of the React host so the
// invariant is unit-testable:
//
//   • Collapsed  → a nonce does ZERO work (no recall, no decrypt).
//   • Open       → a nonce runs the CHEAP candidate-recall only; if the candidate
//                  set changed it raises a "refresh available" SIGNAL. The
//                  expensive decrypt-verify NEVER auto-runs on a nonce path.
//   • Verify     → reachable ONLY from an explicit expand (first open) or refresh.
//
// The host owns the async work; the reducer only decides which effect to run and
// tracks the candidate signature the displayed results were verified against.

/** What the host should run after a reducer step. `verify` is the expensive
 *  decrypt path and is emitted only for explicit user intent. */
export type MentionsEffect = "none" | "cheap-recall" | "verify";

export type MentionsState = {
  /** Section expanded (the only state in which any work happens). */
  readonly expanded: boolean;
  /** Candidate signature the displayed mentions were decrypt-verified against;
   *  `null` = never verified (so a stray cheap-recall can't flag a refresh). */
  readonly computedSig: string | null;
  /** A cheap recall saw a candidate set differing from {@link computedSig} —
   *  the user may refresh to pay the decrypt cost. Never auto-consumed. */
  readonly refreshAvailable: boolean;
};

export type MentionsAction =
  /** User opened the section (explicit intent). */
  | { type: "expand" }
  /** User closed the section. */
  | { type: "collapse" }
  /** Vault-change nonce (SYNC-5) advanced. */
  | { type: "nonce" }
  /** A cheap candidate-recall completed with this candidate-set signature. */
  | { type: "candidate-sig"; sig: string }
  /** User clicked refresh (explicit intent to pay the decrypt cost). */
  | { type: "refresh" }
  /** A decrypt-verify completed against this candidate-set signature. */
  | { type: "verified"; sig: string };

export const initialMentionsState: MentionsState = {
  expanded: false,
  computedSig: null,
  refreshAvailable: false,
};

const NONE = { effect: "none" as const };

/**
 * Pure two-tier reducer. Returns the next state plus the single effect the host
 * should run. The SYNC-14 invariant — a `nonce` or `candidate-sig` never yields
 * `verify` — is structural here: only `expand` (uncomputed) and `refresh` do.
 */
export function reduceMentions(
  state: MentionsState,
  action: MentionsAction,
): { state: MentionsState; effect: MentionsEffect } {
  switch (action.type) {
    case "expand": {
      const next = { ...state, expanded: true };
      // First open computes; re-opening shows the cache (staleness is the
      // refresh affordance's job, not an implicit re-decrypt).
      return {
        state: next,
        effect: state.computedSig === null ? "verify" : "none",
      };
    }

    case "collapse":
      // Keep computedSig + refreshAvailable so re-expand restores the cache and
      // any pending refresh signal.
      return { state: { ...state, expanded: false }, ...NONE };

    case "nonce":
      // The whole point of the two tiers: collapsed → nothing; open → cheap
      // recall only. Never the decrypt path.
      return {
        state,
        effect: state.expanded ? "cheap-recall" : "none",
      };

    case "candidate-sig": {
      // The cheap recall's result. It can only RAISE the refresh signal (never
      // run the decrypt) and only once results exist to be stale against.
      if (
        !state.expanded ||
        state.computedSig === null ||
        action.sig === state.computedSig ||
        state.refreshAvailable
      ) {
        return { state, ...NONE };
      }
      return { state: { ...state, refreshAvailable: true }, ...NONE };
    }

    case "refresh":
      // Explicit decrypt-verify — but cannot bypass the collapsed gate.
      return { state, effect: state.expanded ? "verify" : "none" };

    case "verified":
      // Fresh results are now shown — record their signature, clear the signal.
      return {
        state: { ...state, computedSig: action.sig, refreshAvailable: false },
        ...NONE,
      };
  }
}
