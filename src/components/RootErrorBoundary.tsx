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
 * **Logs no PAYLOAD and records one LOCATION.** A render error's message and
 * props can embed note plaintext (DENY-list, `src-tauri/AGENTS.md`
 * "Secret-handling logging discipline"), so neither travels: not to disk, not to
 * the console, not into the copied report. What the catch DOES leave behind is
 * `data-render-error` on `<html>` — the error's CONSTRUCTOR name and the
 * file:line of its first stack frame, nothing else, bounded to 120 characters.
 *
 * That attribute exists because the alternative was measured: a scenario that
 * ends on this card could only be described as "the editor never appeared", and
 * the difference between a null dereference in one component and a bad read in
 * another is the whole investigation. A source location is not user data — it is
 * the same file:line the minified bundle already exposes — and it never includes
 * the message, a prop, or anything a note contains.
 */
export class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // The LOCATION only — see the class doc. A stack's first frame is
    // `at fn (file:line:col)`, and the file:line pair is what names the fault.
    try {
      const name =
        error instanceof Error ? error.name : typeof error === "string" ? "string" : "unknown";
      const frame = /([^\s()]+\.(?:tsx?|jsx?)):(\d+)/.exec(
        error instanceof Error ? (error.stack ?? "") : "",
      );
      const where = frame === null ? "no-frame" : `${frame[1]}:${frame[2]}`;
      document.documentElement.dataset.renderError = `${name}@${where}`.slice(0, 120);
    } catch {
      // A diagnostic must never become the failure it describes.
    }
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
