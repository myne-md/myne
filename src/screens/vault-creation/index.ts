// Barrel re-exports for the vault-creation orchestrator surface.
// The step components are imported directly by `<CreateVault>`; what this
// barrel carries is the reducer surface plus the step roster the eyebrows
// number themselves from.

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
export {
  NUMBERED_STEPS,
  stepPosition,
  isNumberedStep,
} from "./stepOrder";
export type { NumberedStep } from "./stepOrder";
