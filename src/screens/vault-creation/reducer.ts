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
  | "password"
  | "encrypting"
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
 * State transitions. Every dispatched action lands here exactly once;
 * the `assertNever(action)` default arm guarantees compile-time
 * exhaustiveness — adding a new action without a case is a TS error.
 *
 * Diagram (informally):
 *   password    →[BEGIN_REQUESTED]→ encrypting
 *   encrypting  →[BEGIN_OK]→ phrase
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
  | { type: "BEGIN_REQUESTED" }
  | {
      type: "BEGIN_OK";
      phrase: string[];
      accountNumber: string;
      sessionToken: string;
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
    case "BEGIN_REQUESTED":
      return { ...state, step: "encrypting", error: null };
    case "BEGIN_OK":
      return {
        ...state,
        step: "phrase",
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
