// Vault-creation orchestrator state machine.
//
// Implements the design session decisions in
// agent-tooling/sessions/design/2026-04-28-vault-creation-frontend.md
// (Q2 state machine, Q3 phrase confirmation, Q7 error UX, Q8 cleanup).
//
// Secret material (phrase, accountNumber, sessionToken) lives only in
// this state's scope while <CreateVault> is mounted; on unmount, the
// orchestrator's useEffect cleanup fires `cancel(sessionToken)` and
// React drops the state. Window-close = OS process exit = memory wipe.

import { drawPhraseChallenge } from "@myne/client-core/phrase-challenge";

export type Step =
  | "briefing"
  /**
   * What to call this vault (myne-md/myne#468 K10). Before the password rather
   * than after it, so the name is in hand for the recovery kit's header and for
   * the file it offers to save.
   *
   * The label cannot be written here: `prefs.setVaultLabel` is unlock-gated, and
   * at this point no vault exists. It rides in reducer state and is applied once
   * the chained auto-unlock has opened the vault it names.
   */
  | "name"
  | "password"
  | "encrypting"
  /**
   * The vault is written locally and is being registered with the sync server,
   * BEFORE the phrase is shown (`decisions.md` 2026-08-15).
   *
   * Entered only where sync is required (the web client). The ordering is the
   * load-bearing part, not the spinner: `recovery-flow.md` §2.4 is a
   * no-re-display commitment, so a phrase shown before a failed registration
   * leaves the user holding 24 words for an account that does not exist, and a
   * retry mints a DIFFERENT phrase, silently making the words they wrote down
   * wrong for the vault they end up with. Desktop never enters this step: its
   * creation has no server leg to fail.
   */
  | "provisioning"
  /**
   * The recovery kit: the phrase and the account number on ONE screen, styled as
   * a preview of the file being saved (myne-md/myne#468 K11/K13).
   *
   * They were two consecutive steps, and the merge is the finding rather than a
   * tidy-up: no product surveyed in `agent-tooling/features/onboarding/research.md`
   * asks a user to absorb two back-to-back "keep this forever" moments, and the
   * second one arrived after the phrase challenge had already been passed, which
   * reads as an epilogue. One screen, one save, one acknowledgement.
   */
  | "kit"
  | "confirm"
  | "committing"
  | "ready"
  | "session-lost";

// Steps that hold reveal-able secret material on screen. Closing the
// window here drops the recovery phrase before the user has saved it,
// so the orchestrator's onCloseRequested listener prompts for confirm
// (design session Q8.2). Other steps close immediately.
const SENSITIVE_STEP_SET: ReadonlySet<Step> = new Set(["kit", "confirm"]);

export function isSensitiveStep(step: Step): boolean {
  return SENSITIVE_STEP_SET.has(step);
}

/**
 * User-facing error message produced by `mapAppErrorToUserMessage`
 * (see src/lib/vault-creation-errors.ts).
 *
 * - `displayMode: "inline"` → render as a banner inside the source step
 *   (PasswordStep for BEGIN_ERR, AccountStep for COMMIT_ERR).
 * - `displayMode: "dedicated"` → route to <SessionLostStep>.
 */
export interface ErrorState {
  title: string;
  body: string;
  primaryAction: "retry" | "restart";
  displayMode: "inline" | "dedicated";
}

export interface VaultCreationState {
  step: Step;
  /**
   * What the user typed on the `name` step, trimmed at submit. Empty means they
   * left it blank, which is allowed: the picker already has a fallback label.
   *
   * NOT secret, and the one field that survives `COMMIT_OK` and the two resets.
   * It has to: the label is applied after the chained auto-unlock, which happens
   * on the `ready` step, and sending the user back to the password step must not
   * silently discard a name they typed one step earlier.
   */
  vaultName: string;
  // Set by BEGIN_OK; cleared by RESET / RESET_TO_PASSWORD / SESSION_LOST.
  phrase: string[] | null;
  accountNumber: string | null;
  sessionToken: string | null;
  // 4 random positions selected at BEGIN_OK; stable across CONFIRM_BACK
  // navigation. Biased drawing: 1 from [1,8], 2 from
  // [9,16] (distinct), 1 from [17,24]. See drawConfirmPositions().
  confirmPositions: readonly [number, number, number, number] | null;
  // Position → user-typed value. Reset on RESET_TO_PASSWORD / RESET only.
  confirmInputs: Readonly<Record<number, string>>;
  // <KitStep> reveal flag; window-blur dispatches PHRASE_HIDDEN.
  phraseRevealed: boolean;
  // Inline (PasswordStep / ConfirmStep) or dedicated (SessionLostStep) error.
  error: ErrorState | null;
}

export const initialState: VaultCreationState = {
  step: "name",
  vaultName: "",
  phrase: null,
  accountNumber: null,
  sessionToken: null,
  confirmPositions: null,
  confirmInputs: {},
  phraseRevealed: false,
  error: null,
};

/**
 * Initial reducer state for `<CreateVault>`'s `useReducer`. `withBriefing`
 * (first-run welcome entry, MYND-114) opens the flow on the safety-briefing
 * step; every other entry (picker / switcher "create another") starts on
 * `name`, since the user has already acknowledged the recovery model
 * once. `RESET_TO_PASSWORD` / `RESET` return to `password` (post-briefing,
 * post-name) — the one-time briefing is never re-shown mid-flow, and neither is
 * the name step, whose answer is carried across both resets instead.
 *
 * The briefing step holds no reducer state: its per-statement
 * acknowledgement checkboxes and "Why?" disclosures live in
 * `<BriefingStep>`'s local component state (the step is never re-entered
 * via back-navigation — "Back" from password exits the flow through the
 * reprobe path, same as before the briefing existed).
 */
export function makeInitialState(withBriefing: boolean): VaultCreationState {
  return withBriefing ? { ...initialState, step: "briefing" } : initialState;
}

/**
 * State transitions. Every dispatched action lands here exactly once;
 * the `assertNever(action)` default arm guarantees compile-time
 * exhaustiveness — adding a new action without a case is a TS error.
 *
 * Diagram (informally):
 *   briefing    →[BRIEFING_ACKED]→ name (first-run only, MYND-114)
 *   name        →[NAME_SUBMITTED]→ password
 *   password    →[PASSWORD_BACK]→ name (typed name preserved)
 *   password    →[BEGIN_REQUESTED]→ encrypting
 *   encrypting  →[BEGIN_OK]→ kit               (sync optional: desktop)
 *   encrypting  →[BEGIN_OK requiresProvisioning]→ provisioning   (sync required: web)
 *   provisioning →[PROVISION_OK]→ kit
 *   provisioning →[PROVISION_ERR]→ session-lost (nothing was created)
 *   encrypting  →[BEGIN_ERR]→ password (with inline error)
 *   kit         →[PHRASE_ACKED]→ confirm
 *   kit         →[RESET_TO_PASSWORD]→ password (cancel session)
 *   confirm     →[CONFIRM_BACK]→ kit (positions preserved)
 *   confirm     →[COMMIT_REQUESTED]→ committing
 *   committing  →[COMMIT_OK]→ ready
 *   committing  →[COMMIT_ERR]→ confirm (with inline error)
 *   *           →[SESSION_LOST]→ session-lost (dedicated)
 *   session-lost →[RESET]→ password
 */
export type Action =
  | { type: "BRIEFING_ACKED" }
  | { type: "NAME_CHANGED"; value: string }
  | { type: "NAME_SUBMITTED" }
  | { type: "PASSWORD_BACK" }
  | { type: "BEGIN_REQUESTED" }
  | {
      type: "BEGIN_OK";
      phrase: string[];
      accountNumber: string;
      sessionToken: string;
      /**
       * Where sync is required, `begin` does not lead to the recovery kit. The
       * flow goes through `provisioning` first, and the phrase is only shown
       * once the account exists on the server.
       */
      requiresProvisioning?: boolean;
    }
  | { type: "BEGIN_ERR"; error: ErrorState }
  | { type: "PHRASE_REVEALED" }
  | { type: "PHRASE_HIDDEN" }
  | { type: "PHRASE_ACKED" }
  | { type: "CONFIRM_INPUT_CHANGED"; position: number; value: string }
  | { type: "CONFIRM_BACK" }
  | { type: "PROVISION_OK" }
  | { type: "PROVISION_ERR"; error: ErrorState }
  | { type: "COMMIT_REQUESTED" }
  | { type: "COMMIT_OK" }
  | { type: "COMMIT_ERR"; error: ErrorState }
  | { type: "RESET_TO_PASSWORD" }
  | { type: "RESET" }
  | { type: "SESSION_LOST"; error: ErrorState };

function assertNever(x: never): never {
  throw new Error(`Unhandled vault-creation action: ${JSON.stringify(x)}`);
}

/**
 * Biased random drawing of 4 confirm positions, 1-BASED for this ceremony:
 *   [0]: one position in [1, 8]
 *   [1], [2]: two distinct positions in [9, 16]
 *   [3]: one position in [17, 24]
 *
 * The rule itself lives in `@myne/client-core/phrase-challenge`, shared with the mobile
 * client, which drew four uniform positions until myne-md/myne#851 and so lost the
 * last-third guarantee on about one screen in six. See that module's header for the whole
 * argument. This function is the +1 map onto this ceremony's own 1-based presentation,
 * which `PhraseTypeBack` and the reducer's `CONFIRM_INPUT_CHANGED` are keyed by; the mobile
 * flow keeps a 0-based array. Only the DRAW is shared, not the indexing.
 */
export function drawConfirmPositions(): readonly [number, number, number, number] {
  const [a, b, c, d] = drawPhraseChallenge();
  return [a + 1, b + 1, c + 1, d + 1] as const;
}

/**
 * Normalize a word for confirmation comparison: NFKD + trim + lowercase. Trailing
 * whitespace and case mismatches must not falsely block the user; the recovery flow
 * (Phase 1 DoD drill) applies the same normalization when accepting typed phrase input.
 *
 * The body moved to `@myne/client-core/phrase-challenge` in myne-md/myne#851, where the
 * mobile client's byte-identical copy of it lived too, and is re-exported here so every
 * existing importer of `normalizeWord` is unchanged.
 */
export { normalizePhraseWord as normalizeWord } from "@myne/client-core/phrase-challenge";

export function vaultCreationReducer(
  state: VaultCreationState,
  action: Action,
): VaultCreationState {
  switch (action.type) {
    case "BRIEFING_ACKED":
      // First-run safety briefing acknowledged (MYND-114) → naming the vault.
      // Idempotent from `name` (the dev `?test-step` harness dispatches it
      // unconditionally), so it never regresses the step.
      return { ...state, step: "name" };
    case "NAME_CHANGED":
      return { ...state, vaultName: action.value };
    case "NAME_SUBMITTED":
      // Trimmed HERE rather than in the step, so every consumer of `vaultName`
      // reads the same value and a name of only spaces is the empty case rather
      // than a label the picker would render as blank.
      return { ...state, step: "password", vaultName: state.vaultName.trim() };
    case "PASSWORD_BACK":
      // A real back-step now that something precedes the password, and it keeps
      // `vaultName`: re-asking for a name the user already gave is the whole
      // failure a Back control is supposed to avoid.
      return { ...state, step: "name", error: null };
    case "BEGIN_REQUESTED":
      return { ...state, step: "encrypting", error: null };
    case "BEGIN_OK":
      return {
        ...state,
        step: action.requiresProvisioning ? "provisioning" : "kit",
        phrase: action.phrase,
        accountNumber: action.accountNumber,
        sessionToken: action.sessionToken,
        confirmPositions: drawConfirmPositions(),
        confirmInputs: {},
        phraseRevealed: false,
        error: null,
      };
    case "BEGIN_ERR":
      return { ...state, step: "password", error: action.error };
    case "PROVISION_OK":
      return { ...state, step: "kit", error: null };
    case "PROVISION_ERR":
      // Dedicated rather than inline, and terminal rather than retryable: the
      // container has been erased and the session cancelled, so there is
      // nothing for a retry to resume. The user starts over with a fresh
      // account number and a fresh phrase, which is exactly right — the phrase
      // they never saw was never written down.
      return {
        ...state,
        step: "session-lost",
        phrase: null,
        accountNumber: null,
        sessionToken: null,
        error: action.error,
      };
    case "PHRASE_REVEALED":
      return { ...state, phraseRevealed: true };
    case "PHRASE_HIDDEN":
      return { ...state, phraseRevealed: false };
    case "PHRASE_ACKED":
      return { ...state, step: "confirm" };
    case "CONFIRM_INPUT_CHANGED":
      return {
        ...state,
        confirmInputs: {
          ...state.confirmInputs,
          [action.position]: action.value,
        },
      };
    case "CONFIRM_BACK":
      // Preserve confirmPositions and confirmInputs; only step changes.
      return { ...state, step: "kit" };
    case "COMMIT_REQUESTED":
      return { ...state, step: "committing", error: null };
    case "COMMIT_OK":
      // Drop every reference to the recovery phrase, account number,
      // session token, and confirmation inputs. ReadyStep reads none
      // of them. Without this reset the secret material would sit in
      // the React tree until the user clicks "Done"; minimising the
      // residence window narrows the local-memory exposure surface
      // (TB1).
      //
      // `vaultName` is carried across, and it is the one field that is: it is not
      // secret, and `ReadyStep`'s Done button is what triggers the auto-unlock
      // that finally applies it as the vault's label. Resetting it here would
      // drop the name one action before the only place it can be written.
      return { ...initialState, step: "ready", vaultName: state.vaultName };
    case "COMMIT_ERR":
      // Back to the confirm step, which is where the commit was requested from
      // now that the account number no longer has a step of its own. The typed
      // words are still in state, so the inline banner appears above a challenge
      // the user has already passed and can retry with one click.
      return { ...state, step: "confirm", error: action.error };
    case "RESET_TO_PASSWORD":
    case "RESET":
      // `password`, not `initialState.step` — that is now `name`, and neither
      // reset re-asks a question already answered. The name survives both.
      return { ...initialState, step: "password", vaultName: state.vaultName };
    case "SESSION_LOST":
      return {
        ...initialState,
        step: "session-lost",
        vaultName: state.vaultName,
        error: action.error,
      };
    default:
      return assertNever(action);
  }
}
