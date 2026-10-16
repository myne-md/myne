import React from "react";

import { FailClosedError } from "./FailClosedError";
import { failClosedCode } from "../lib/global-failure";

interface RootErrorBoundaryState {
  failed: boolean;
}

/**
 * App-root error boundary. Without it, any uncaught render exception anywhere in
 * the tree unmounts the WHOLE app to a blank white screen with no recovery —
 * even from an unlocked session. Catch it and render the shared fail-closed
 * surface; the CTA reloads the WebView (a fresh boot re-probes the vault and
 * lands on the unlock screen).
 *
 * Deliberately logs NOTHING: a render error's message / component stack can
 * embed note plaintext (DENY-list, `src-tauri/AGENTS.md` "Secret-handling
 * logging discipline"). The user-facing fail-closed UI is the recovery path.
 */
export class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(): void {
    // No-op on purpose — see the class doc: never log the error payload.
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <FailClosedError
          reason={{ kind: "invalid-state" }}
          // The card's own closed reason, so the Copy-diagnostics affordance
          // carries a bounded code (myne-md/myne#860). A constant, never the
          // caught error's message: the class doc's no-logging rule still holds,
          // because the block copies an allowlist of scalars and not the
          // payload.
          code={failClosedCode("invalid-state")}
          onCtaClick={() => {
            window.location.reload();
          }}
        />
      );
    }
    return this.props.children;
  }
}
