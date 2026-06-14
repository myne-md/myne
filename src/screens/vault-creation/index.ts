// Barrel re-exports for the vault-creation orchestrator surface.
// Step components (PasswordStep, EncryptingStep, PhraseStep,
// ConfirmStep, AccountStep, ReadyStep, SessionLostStep) land in
// later tasks and will be re-exported here.

export {
  vaultCreationReducer,
  initialState,
  makeInitialState,
  normalizeWord,
  isSensitiveStep,
} from "./reducer";
export type {
  VaultCreationState,
  Step,
  Action,
  ErrorState,
} from "./reducer";
