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

export type Step =
  | "briefing"
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
  | "phrase"
  | "confirm"
  | "account"
  | "committing"
  | "ready"
  | "session-lost";

// Steps that hold reveal-able secret material on screen. Closing the
// window here drops the recovery phrase before the user has saved it,
// so the orchestrator's onCloseRequested listener prompts for confirm
// (design session Q8.2). Other steps close immediately.
const SENSITIVE_STEP_SET: ReadonlySet<Step> = new Set([
  "phrase",
  "confirm",
  "account",
]);

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
  // Set by BEGIN_OK; cleared by RESET / RESET_TO_PASSWORD / SESSION_LOST.
  phrase: string[] | null;
  accountNumber: string | null;
  sessionToken: string | null;
  // 4 random positions selected at BEGIN_OK; stable across CONFIRM_BACK
  // and ACCOUNT_BACK navigation. Biased drawing: 1 from [1,8], 2 from
  // [9,16] (distinct), 1 from [17,24]. See drawConfirmPositions().
  confirmPositions: readonly [number, number, number, number] | null;
  // Position → user-typed value. Reset on RESET_TO_PASSWORD / RESET only.
  confirmInputs: Readonly<Record<number, string>>;
  // <PhraseStep> reveal flag; window-blur dispatches PHRASE_HIDDEN.
  phraseRevealed: boolean;
  // <AccountStep> "I have saved my account number" checkbox.
  accountAcknowledged: boolean;
  // Inline (PasswordStep / AccountStep) or dedicated (SessionLostStep) error.
  error: ErrorState | null;
}

export const initialState: VaultCreationState = {
  step: "password",
  phrase: null,
  accountNumber: null,
  sessionToken: null,
  confirmPositions: null,
  confirmInputs: {},
  phraseRevealed: false,
  accountAcknowledged: false,
  error: null,
};

/**
 * Initial reducer state for `<CreateVault>`'s `useReducer`. `withBriefing`
 * (first-run welcome entry, MYND-114) opens the flow on the safety-briefing
 * step; every other entry (picker / switcher "create another") starts on
 * `password`, since the user has already acknowledged the recovery model
 * once. `RESET_TO_PASSWORD` / `RESET` always return to `password`
 * (post-briefing) — the one-time briefing is never re-shown mid-flow.
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
 *   briefing    →[BRIEFING_ACKED]→ password (first-run only, MYND-114)
 *   password    →[BEGIN_REQUESTED]→ encrypting
 *   encrypting  →[BEGIN_OK]→ phrase            (sync optional: desktop)
 *   encrypting  →[BEGIN_OK requiresProvisioning]→ provisioning   (sync required: web)
 *   provisioning →[PROVISION_OK]→ phrase
 *   provisioning →[PROVISION_ERR]→ session-lost (nothing was created)
 *   encrypting  →[BEGIN_ERR]→ password (with inline error)
 *   phrase      →[PHRASE_ACKED]→ confirm
 *   phrase      →[RESET_TO_PASSWORD]→ password (cancel session)
 *   confirm     →[CONFIRM_BACK]→ phrase (positions preserved)
 *   confirm     →[PHRASE_CONFIRMED]→ account
 *   account     →[ACCOUNT_BACK]→ confirm (already-passed)
 *   account     →[COMMIT_REQUESTED]→ committing
 *   committing  →[COMMIT_OK]→ ready
 *   committing  →[COMMIT_ERR]→ account (with inline error)
 *   *           →[SESSION_LOST]→ session-lost (dedicated)
 *   session-lost →[RESET]→ password
 */
export type Action =
  | { type: "BRIEFING_ACKED" }
  | { type: "BEGIN_REQUESTED" }
  | {
      type: "BEGIN_OK";
      phrase: string[];
      accountNumber: string;
      sessionToken: string;
      /**
       * Where sync is required, `begin` does not lead to the phrase screen. The
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
  | { type: "PHRASE_CONFIRMED" }
  | { type: "CONFIRM_BACK" }
  | { type: "ACCOUNT_ACK_TOGGLED"; checked: boolean }
  | { type: "ACCOUNT_BACK" }
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
 * Biased random drawing of 4 confirm positions:
 *   [0]: one position in [1, 8]
 *   [1], [2]: two distinct positions in [9, 16]
 *   [3]: one position in [17, 24]
 *
 * The biased distribution ensures the typing challenge samples across
 * the full phrase — partial-write detection (user wrote down only the
 * first 16 words) is improved by guaranteeing one position from the
 * last third. See design session Q3 for rationale.
 */
function drawConfirmPositions(): readonly [number, number, number, number] {
  const early = 1 + Math.floor(Math.random() * 8); // 1..8
  const mid = [9, 10, 11, 12, 13, 14, 15, 16];
  const i1 = Math.floor(Math.random() * mid.length);
  let i2 = Math.floor(Math.random() * (mid.length - 1));
  if (i2 >= i1) i2 += 1;
  const late = 17 + Math.floor(Math.random() * 8); // 17..24
  return [early, mid[i1], mid[i2], late] as const;
}

/**
 * Normalize a word for confirmation comparison: NFKD + trim + lowercase.
 * Trailing whitespace and case mismatches must not falsely block the
 * user; recovery flow (Phase 1 DoD drill) applies the same normalization
 * when accepting typed phrase input.
 */
export function normalizeWord(s: string): string {
  return s.normalize("NFKD").trim().toLowerCase();
}

export function vaultCreationReducer(
  state: VaultCreationState,
  action: Action,
): VaultCreationState {
  switch (action.type) {
    case "BRIEFING_ACKED":
      // First-run safety briefing acknowledged (MYND-114) → password
      // setup. Idempotent from `password` (the dev `?test-step` harness
      // dispatches it unconditionally), so it never regresses the step.
      return { ...state, step: "password" };
    case "BEGIN_REQUESTED":
      return { ...state, step: "encrypting", error: null };
    case "BEGIN_OK":
      return {
        ...state,
        step: action.requiresProvisioning ? "provisioning" : "phrase",
        phrase: action.phrase,
        accountNumber: action.accountNumber,
        sessionToken: action.sessionToken,
        confirmPositions: drawConfirmPositions(),
        confirmInputs: {},
        phraseRevealed: false,
        accountAcknowledged: false,
        error: null,
      };
    case "BEGIN_ERR":
      return { ...state, step: "password", error: action.error };
    case "PROVISION_OK":
      return { ...state, step: "phrase", error: null };
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
    case "PHRASE_CONFIRMED":
      return { ...state, step: "account" };
    case "CONFIRM_BACK":
      // Preserve confirmPositions and confirmInputs; only step changes.
      return { ...state, step: "phrase" };
    case "ACCOUNT_ACK_TOGGLED":
      return { ...state, accountAcknowledged: action.checked };
    case "ACCOUNT_BACK":
      return { ...state, step: "confirm" };
    case "COMMIT_REQUESTED":
      return { ...state, step: "committing", error: null };
    case "COMMIT_OK":
      // Drop every reference to the recovery phrase, account number,
      // session token, and confirmation inputs. ReadyStep reads none
      // of them. Without this reset the secret material would sit in
      // the React tree until the user clicks "Done"; minimising the
      // residence window narrows the local-memory exposure surface
      // (TB1).
      return { ...initialState, step: "ready" };
    case "COMMIT_ERR":
      return { ...state, step: "account", error: action.error };
    case "RESET_TO_PASSWORD":
    case "RESET":
      return initialState;
    case "SESSION_LOST":
      return { ...initialState, step: "session-lost", error: action.error };
    default:
      return assertNever(action);
  }
}
