// Inline error banner used by <PasswordStep> (BEGIN_ERR) and <AccountStep>
// (COMMIT_ERR). Recoverable AppError variants render here; session-lost
// variants route to <SessionLostStep>. See vault-creation-errors.ts +
// design session Q7.
//
// `role="alert"` + `aria-live="polite"` so screen readers announce the
// error when it appears without the user having to navigate to find it.

import type { ErrorState } from "../screens/vault-creation";

interface ErrorBannerProps {
  error: ErrorState;
}

export function ErrorBanner({ error }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        padding: 12,
        background: "var(--danger-soft)",
        border: "1px solid var(--danger)",
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontWeight: 600,
          marginBottom: 4,
          color: "var(--fg-1)",
        }}
      >
        {error.title}
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--fg-2)",
        }}
      >
        {error.body}
      </div>
    </div>
  );
}
