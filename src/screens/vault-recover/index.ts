// Barrel re-exports for the vault-recover module surface.
//
// Sub-step components (PhraseEntryStep, DecryptingStep,
// PasswordResetStep) and the reducer types are exposed here so
// `src/screens/VaultRecover.tsx` (the orchestrator) imports a single
// path. Mirrors `src/screens/vault-creation/index.ts`'s shape.

export {
  vaultRecoverReducer,
  initialState,
  EMPTY_CELLS,
  PHRASE_CELL_COUNT,
} from "./reducer";
export type {
  VaultRecoverState,
  Action,
  PhraseOutcome,
  PasswordOutcome,
  FailClosedReason,
} from "./reducer";

export { StepShell } from "./step-shell";
export { PhraseEntryStep } from "./PhraseEntryStep";
export { DecryptingStep } from "./DecryptingStep";
export { PasswordResetStep } from "./PasswordResetStep";
