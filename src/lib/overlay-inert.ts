// Re-export of the shared overlay `inert` owner (myne-md/myne#728, task 8).
//
// The implementation lives in the editor package (`editor/src/host/lib/`)
// because the imperative modals (`imperative-modal.ts`, which `promptForText`
// and friends build on) register with it too, and the editor may not import
// from `src/`. One module instance is what makes the stack shared: this shim
// resolves to the same editor module the imperative skeleton imports, so a
// React overlay and a vanilla-DOM one occupy one stack.
//
// The React binding (`src/hooks/useOverlayInert.ts`) and the one escape hatch
// (`src/components/ScreenCaptureEscape.tsx`) import this path unchanged.
export * from "@myne/editor/host/lib/overlay-inert";
