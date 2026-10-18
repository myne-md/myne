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
import type { DeleteVaultPartialFailContext } from "../../lib/vault-delete";
import { RECOVERY_NON_DISTINGUISHING_BANNER as NON_DISTINGUISHING_BANNER } from "../../lib/load-bearing-copy";

/** Reason used to render `<FailClosedError>`. Recover never produces
 *  `io-error` here — IO failures stay banner-retry per Q7 (E1/E2). */
export type FailClosedReason = "corrupted-vault" | "invalid-state";

/** Sub-step state machine state. */
export interface VaultRecoverState {
  subStep: RecoverSubStep;
  /**
   * MYND-206: the chosen target `VaultId` (canonical string) once the
   * multi-vault recovery selection stage resolves one — either by a picker row
   * click or a successful account-number match. `null` for the single-vault
   * flow (no selection was made; the IPC layer falls back to the sole vault).
   * Threaded into BOTH `recover_with_phrase` (A8d) and `complete_recovery`
   * (A8f) so the whole pipeline reads the SAME chosen vault's `vault.meta`
   * (SYNC-6 targeting). Set once at `vault-selected`; never cleared, so an A8f
   * IO-failure bounce back to `phrase-entry` retries against the same vault.
   */
  vaultId: string | null;
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
  /** MYND-108-bis: in-flight flag for the `delete-confirm` sub-step
   *  during the `vault_delete` IPC window. Mirrors the AccountPanel +
   *  Unlock screen pattern. `false` outside the `delete-confirm`
   *  sub-step. */
  deleteInFlight: boolean;
  /** MYND-108-bis: post-fail context for the `delete-confirm` sub-step.
   *  Non-null when the IPC returned `PartialDelete` or `Io` and the
   *  user is reading the banner before clicking Continue. `null`
   *  outside the `delete-confirm` sub-step or before the first reject. */
  deletePartialFail: DeleteVaultPartialFailContext | null;
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
  /** MYND-206: the mount-time multi-vault gate found ≥2 vaults on disk, so
   *  recovery must pick one BEFORE phrase entry. Moves `phrase-entry → select`.
   *  Fired once by the orchestrator's gate effect on a cold-start mount; a
   *  no-op outside `phrase-entry` (so it can't disturb a resumed
   *  `password-reset` or an in-progress grid). The single-vault flow never
   *  dispatches it (≤1 vault stays in phrase-entry, sole-vault fallback). */
  | { type: "enter-select" }
  /** MYND-206: the multi-vault recovery selection stage resolved a target
   *  `VaultId` (a picker row click OR a successful account-number match).
   *  Stores the id and advances `select → phrase-entry`. No-op outside the
   *  `select` sub-step. */
  | { type: "vault-selected"; vaultId: string }
  /** myne-md/myne#684: the sibling notice's "recover another" action. From
   *  `password-reset`, returns to the `select` sub-step so the user can pick
   *  the next sibling vault. Wipes the password (the field's React state drops
   *  on unmount, but the reducer mirror is wiped for hygiene). */
  | { type: "recover-another" }
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
  | { type: "password-result"; outcome: PasswordOutcome }
  /** MYND-108-bis: user clicked the "Delete vault and start over"
   *  footer link in phrase-entry. Transitions to the `delete-confirm`
   *  sub-step. No-op from any other sub-step (PasswordResetStep is
   *  non-dismissible per recovery-flow.md §4.1 / §4.3). */
  | { type: "request-delete" }
  /** MYND-108-bis: user clicked Cancel inside the delete-confirm
   *  form (idle mode only). Returns to phrase-entry sub-step. Cells
   *  preserved (user might want to retry recovery after canceling
   *  the delete intent). */
  | { type: "cancel-delete" }
  /** MYND-108-bis: consumer fired the `vault_delete` IPC and is
   *  waiting for the response. Sets `deleteInFlight = true`. */
  | { type: "delete-in-flight" }
  /** MYND-108-bis: IPC rejected with PartialDelete or Io. Stores
   *  the form's post-fail context (count + resolved vault path).
   *  Clears `deleteInFlight`. */
  | { type: "delete-partial-fail"; context: DeleteVaultPartialFailContext }
  /** MYND-108-bis: IPC rejected with a bug-canary variant
   *  (VaultBusyAuth / VaultNotUnlocked / VaultNotFound). Clears
   *  `deleteInFlight`; stays in delete-confirm sub-step. The
   *  consumer emits a dev-only `console.warn`. */
  | { type: "delete-bug-canary" };

import { PHRASE_CELL_COUNT } from "../../lib/phrase-cells";

// Re-exported rather than redeclared: this file used to carry its own `24`, and
// so did four other files. The one definition is in
// `lib/bip39-normalize.ts`, next to the §7.4 normalization the count is paired
// with.
export { PHRASE_CELL_COUNT };

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
    vaultId: null,
    cells: EMPTY_CELLS,
    password: "",
    banner: null,
    failClosed: null,
    deleteInFlight: false,
    deletePartialFail: null,
  };
}

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
    case "enter-select": {
      // MYND-206: the mount-time gate found ≥2 vaults. Move into the selection
      // sub-step. Guarded to `phrase-entry` so a resumed `password-reset` or an
      // already-progressing flow is never yanked back. Cells/banner reset
      // defensively (the gate fires before any typing on a cold start).
      if (state.subStep !== "phrase-entry") return state;
      return { ...state, subStep: "select", cells: EMPTY_CELLS, banner: null };
    }
    case "vault-selected": {
      // MYND-206: only reachable from the multi-vault `select` sub-step. Store
      // the chosen VaultId and advance to phrase-entry against that vault. The
      // single-vault flow never reaches `select` (it mounts straight in
      // phrase-entry with `vaultId = null`).
      if (state.subStep !== "select") return state;
      return { ...state, subStep: "phrase-entry", vaultId: action.vaultId };
    }
    case "recover-another": {
      // myne-md/myne#684: from password-reset, return to the select sub-step so
      // the user can pick the next sibling vault. Wipe the password mirror.
      if (state.subStep !== "password-reset") return state;
      return { ...state, subStep: "select", password: "", banner: null };
    }
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
          // also drops on PasswordCreateForm unmount, but the reducer's
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
          // A8f IO/JoinFailure: the rewrite never landed (atomic
          // rename gates), and the HOST keeps `Slot::Recovering` —
          // the snapshot-clone pipeline never consumed the slot
          // (pinned by the vr11′ E2E scenario; an earlier version of
          // this comment wrongly claimed the slot drops to Empty).
          // UI-side we bounce to phrase-entry with the banner; a
          // re-entered phrase silently advances via the Q4
          // RecoveryAlreadyInProgress swap, and a plain unlock
          // attempt surfaces the resume banner instead.
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
    case "request-delete": {
      // MYND-108-bis: only reachable from phrase-entry. PasswordResetStep
      // stays non-dismissible per `recovery-flow.md` §4.1 / §4.3.
      if (state.subStep !== "phrase-entry") return state;
      return {
        ...state,
        subStep: "delete-confirm",
        banner: null,
        deleteInFlight: false,
        deletePartialFail: null,
      };
    }
    case "cancel-delete": {
      // Permitted only when NOT inFlight (the form hides Cancel
      // during the IPC window).
      if (state.subStep !== "delete-confirm" || state.deleteInFlight) {
        return state;
      }
      return {
        ...state,
        subStep: "phrase-entry",
        deleteInFlight: false,
        deletePartialFail: null,
      };
    }
    case "delete-in-flight": {
      if (state.subStep !== "delete-confirm") return state;
      return { ...state, deleteInFlight: true };
    }
    case "delete-partial-fail": {
      if (state.subStep !== "delete-confirm") return state;
      return {
        ...state,
        deleteInFlight: false,
        deletePartialFail: action.context,
      };
    }
    case "delete-bug-canary": {
      if (state.subStep !== "delete-confirm") return state;
      return { ...state, deleteInFlight: false };
    }
  }
}
