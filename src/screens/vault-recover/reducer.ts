// Vault-recover sub-step reducer.
//
// Mirrors `src/screens/vault-creation/reducer.ts`'s shape: a single
// `useReducer` state machine with a discriminated `Action` union and
// a pure `vaultRecoverReducer` function. Three sub-steps (`phrase-entry`
// | `decrypting` | `password-reset`) plus a fail-closed escape hatch.
//
// **Q4 silent-recovery encoding.** When the IPC layer reports a slot
// disagreement (`RecoveryAlreadyInProgress` from A8d on a slot already
// `Recovering`; `VaultRecoveryRequiresActiveSession` from A8f on a
// slot that became `Empty`), the reducer collapses the mismatch by
// transitioning sub-step + clearing the relevant secret material —
// no banner, no fail-closed surface. Rust slot is the source of
// truth; React Stage adapts.
//
// **Q7 error-mapping discipline.** Banner copy is consumer-side
// (PhraseEntryStep / PasswordResetStep map IPC error variants to TR
// strings before dispatching `phrase-result` / `password-result`).
// The reducer only encodes the consequence shape: which sub-step,
// what to wipe, what banner string to display, whether to fail-closed.
//
// **Cell wipe rule (spec §3.4).** All 24 cells wipe ONLY on the
// non-distinguishing AEAD-tag failure (`InvalidCredentialOrVault`).
// Other A8d failures (IO, VaultNotFound, JoinFailure, RecoveryInProgress)
// preserve cells so the user can retry without retyping. Successful
// transitions to `password-reset` ALSO wipe cells (best-effort hygiene
// — typed phrase plaintext is no longer load-bearing once
// `Slot::Recovering` is populated server-side).
//
// **Password wipe rule.** Wipes on every transition out of
// `password-reset` that returns to `phrase-entry` (Q4 silent or A8f
// IO failure). Stays put on `RecoveryInProgress` (semaphore busy —
// user retries the same submit).

import type { RecoverSubStep } from "../../lib/stage";

/** Reason used to render `<FailClosedError>`. Recover never produces
 *  `io-error` here — IO failures stay banner-retry per Q7 (E1/E2). */
export type FailClosedReason = "corrupted-vault" | "invalid-state";

/** Sub-step state machine state. */
export interface VaultRecoverState {
  subStep: RecoverSubStep;
  /** 24-cell phrase grid. Reads as immutable; all reducer writes
   *  produce a fresh array. Length is fixed at 24. */
  cells: readonly string[];
  /** New master password typed in `password-reset`. */
  password: string;
  /** Single-line banner copy already mapped to TR by the consumer.
   *  `null` = no banner. */
  banner: string | null;
  /** When non-null, the recover screen unmounts the sub-step
   *  components and renders `<FailClosedError>` with this reason. */
  failClosed: FailClosedReason | null;
}

/** Outcome variants produced by the consumer of `recover_with_phrase`
 *  (A8d) IPC after mapping the Rust error enum to UX consequences
 *  per Q7. The reducer encodes the consequence shape. */
export type PhraseOutcome =
  | { kind: "success" }
  | { kind: "non-distinguishing" }
  | { kind: "banner-retry"; banner: string }
  | { kind: "already-recovering" }
  | { kind: "fail-closed"; reason: FailClosedReason };

/** Outcome variants produced by the consumer of `complete_recovery`
 *  (A8f) IPC. A8f success is NOT a reducer concern — the consumer
 *  calls `onCompleteSuccess` directly so App.tsx transitions Stage
 *  to `editor` and the recover screen unmounts. */
export type PasswordOutcome =
  | { kind: "needs-active-session" }
  | { kind: "banner-retry"; banner: string }
  | { kind: "io-failure"; banner: string }
  | { kind: "fail-closed"; reason: FailClosedReason };

export type Action =
  /** User typed into a single phrase cell. Whitespace is filtered
   *  (Q5 P5: typed spaces rejected). */
  | { type: "set-cell"; index: number; value: string }
  /** User pasted a multi-token value into a cell. Tokens fill cells
   *  starting at `index` going forward (Q5 P4); cells before `index`
   *  are preserved; tokens beyond cap=24 are silently truncated
   *  (Q5 P2). Single-token paste fills only the target cell (Q5 P3).
   *  Per-token whitespace is filtered defensively. */
  | { type: "paste-into-cell"; index: number; tokens: string[] }
  /** User clicked Submit on phrase-entry. Sub-step transitions to
   *  `decrypting`. The consumer reads `state.cells`, applies §7.4
   *  normalization, and invokes A8d. */
  | { type: "submit-phrase" }
  /** A8d IPC resolved (or rejected) — consumer dispatches the
   *  mapped `PhraseOutcome`. */
  | { type: "phrase-result"; outcome: PhraseOutcome }
  /** User typed into the new-password field. Banner clears on
   *  next keystroke. */
  | { type: "set-password"; value: string }
  /** A8f IPC failure — consumer dispatches the mapped
   *  `PasswordOutcome`. (Success is handled outside the reducer
   *  via `onCompleteSuccess`.) */
  | { type: "password-result"; outcome: PasswordOutcome };

export const PHRASE_CELL_COUNT = 24;

/** Single shared empty-cells reference; cheap to alias because cells
 *  are typed `readonly`. Reducer transitions that wipe cells return
 *  this constant. */
export const EMPTY_CELLS: readonly string[] = Array.from(
  { length: PHRASE_CELL_COUNT },
  () => "",
);

/** Build a fresh initial state for the given entry sub-step. */
export function initialState(initialSubStep: RecoverSubStep): VaultRecoverState {
  return {
    subStep: initialSubStep,
    cells: EMPTY_CELLS,
    password: "",
    banner: null,
    failClosed: null,
  };
}

/** Spec §3.4 non-distinguishing banner. Co-located with the reducer
 *  so the create-vs-recover boundary can't drift the wording. */
const NON_DISTINGUISHING_BANNER =
  "Phrase veya vault dosyası geçersiz. Lütfen tekrar dene.";

function sanitizeCellValue(value: string): string {
  // Q5 P5 — typed whitespace is filtered out at the reducer level
  // (defense in depth; the input component also blocks at onChange).
  return value.replace(/\s+/g, "");
}

export function vaultRecoverReducer(
  state: VaultRecoverState,
  action: Action,
): VaultRecoverState {
  // FailClosed is terminal — no further actions can pull the state
  // out. The consumer's only escape is the `<FailClosedError>` CTA
  // (which closes the app or calls `vault_lock` per the existing
  // FailClosedError contract).
  if (state.failClosed) return state;

  switch (action.type) {
    case "set-cell": {
      if (state.subStep !== "phrase-entry") return state;
      if (action.index < 0 || action.index >= PHRASE_CELL_COUNT) return state;
      const cells = [...state.cells];
      cells[action.index] = sanitizeCellValue(action.value);
      return { ...state, cells, banner: null };
    }
    case "paste-into-cell": {
      if (state.subStep !== "phrase-entry") return state;
      if (action.index < 0 || action.index >= PHRASE_CELL_COUNT) return state;
      const cap = PHRASE_CELL_COUNT - action.index;
      const tokens = action.tokens.slice(0, cap);
      const cells = [...state.cells];
      for (let i = 0; i < tokens.length; i++) {
        cells[action.index + i] = sanitizeCellValue(tokens[i]);
      }
      return { ...state, cells, banner: null };
    }
    case "submit-phrase": {
      if (state.subStep !== "phrase-entry") return state;
      const allFilled = state.cells.every((c) => c.length > 0);
      if (!allFilled) return state;
      return { ...state, subStep: "decrypting", banner: null };
    }
    case "phrase-result": {
      // Outcome is dispatched only while the sub-step is decrypting
      // (the consumer transitions to decrypting via `submit-phrase`
      // before invoking A8d). A defensive `return state` covers any
      // stale dispatch arriving after a sub-step change.
      if (state.subStep !== "decrypting") return state;
      switch (action.outcome.kind) {
        case "success":
          // A8d ok — Slot::Recovering is populated server-side; cells
          // wiped (best-effort hygiene; phrase plaintext no longer
          // load-bearing).
          return {
            ...state,
            subStep: "password-reset",
            cells: EMPTY_CELLS,
            banner: null,
          };
        case "non-distinguishing":
          // Spec §3.4 mandate: wipe all 24 cells, single
          // non-distinguishing banner.
          return {
            ...state,
            subStep: "phrase-entry",
            cells: EMPTY_CELLS,
            banner: NON_DISTINGUISHING_BANNER,
          };
        case "banner-retry":
          // IO / VaultNotFound / RecoveryInProgress / JoinFailure —
          // cells preserved, banner shown, retry from same state.
          return {
            ...state,
            subStep: "phrase-entry",
            banner: action.outcome.banner,
          };
        case "already-recovering":
          // Q4 silent recovery: slot was actually `Recovering` when
          // we tried A8d. Skip ahead to password-reset; wipe the
          // typed cells (no longer relevant — slot already holds the
          // root_key from a prior session).
          return {
            ...state,
            subStep: "password-reset",
            cells: EMPTY_CELLS,
            banner: null,
          };
        case "fail-closed":
          return { ...state, failClosed: action.outcome.reason };
      }
      // Exhaustiveness — unreachable.
      return state;
    }
    case "set-password": {
      if (state.subStep !== "password-reset") return state;
      return { ...state, password: action.value, banner: null };
    }
    case "password-result": {
      if (state.subStep !== "password-reset") return state;
      switch (action.outcome.kind) {
        case "needs-active-session":
          // Q4 silent recovery: slot is now Empty. Restart from
          // phrase-entry. Wipe password (the field's React state
          // also drops on PasswordForm unmount, but the reducer's
          // password mirror is wiped here for hygiene).
          return {
            ...state,
            subStep: "phrase-entry",
            password: "",
            banner: null,
          };
        case "banner-retry":
          // Semaphore busy (RecoveryInProgress). Stay put; user
          // retries the same submit shortly.
          return { ...state, banner: action.outcome.banner };
        case "io-failure":
          // A8f IO/JoinFailure: slot dropped recovering material on
          // failure (post-take_recovering closure), so slot is now
          // Empty. User must re-enter phrase.
          return {
            ...state,
            subStep: "phrase-entry",
            password: "",
            banner: action.outcome.banner,
          };
        case "fail-closed":
          return { ...state, failClosed: action.outcome.reason };
      }
      // Exhaustiveness — unreachable.
      return state;
    }
  }
}
