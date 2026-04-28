// Transient loading screen while the backend `vault-creation:begin`
// command runs Argon2id × 2 in `spawn_blocking` (~1–3 s per RFC).
//
// Implements design session 2026-04-28-vault-creation-frontend.md Q6.1:
//   - Dedicated full-screen step (not an overlay on PasswordStep) so the
//     transition is honest — the user sees "the app is working" rather
//     than a frozen form with a spinner overlay.
//   - No eyebrow (transient state, not a numbered step).
//   - No Cancel button: spawn_blocking is not abortable mid-Argon2id;
//     window-close is the OS-level escape valve. Helper text below the
//     spinner makes that escape path explicit.
//
// Reduced motion: <Spinner> falls back to a static ring under
// `prefers-reduced-motion: reduce` (tokens.css zeroes animation-duration).

import { Spinner } from "../../components/Spinner";
import { StepHeading, StepLayout } from "./step-shell";

export function EncryptingStep() {
  return (
    <StepLayout align="center">
      <Spinner size={36} />
      <div style={{ marginTop: 12 }}>
        <StepHeading centered>Encrypting your vault</StepHeading>
      </div>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.6,
          color: "var(--fg-2)",
          textAlign: "center",
        }}
      >
        This takes a moment.
      </div>
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.5,
          color: "var(--fg-3)",
          textAlign: "center",
          marginTop: 32,
          maxWidth: 320,
        }}
      >
        If this takes longer than 30 seconds, close the window and try again.
      </div>
    </StepLayout>
  );
}
