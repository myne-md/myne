// Chrome wrapper for the recover flow's `phrase-entry` and
// `password-reset` sub-steps. Wraps `<CenteredCard>` with a heading +
// optional body paragraph + an optional banner slot above the
// children. The `decrypting` sub-step bypasses this shell — it uses
// `<BlockingProgressStep>` directly for its full-screen spinner idiom.

import type { CSSProperties, ReactNode } from "react";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
} from "../../components/primitives/CenteredCard";

interface StepShellProps {
  title: string;
  body?: ReactNode;
  /** Optional banner copy. When non-null, rendered as `<div role="alert">`
   *  above the children — matching `Unlock.tsx`'s banner idiom. */
  banner?: string | null;
  children: ReactNode;
}

const BANNER_STYLE: CSSProperties = {
  background: "var(--bg-3)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-4)",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
};

export function StepShell({ title, body, banner, children }: StepShellProps) {
  return (
    <CenteredCard>
      <h1 style={CARD_TITLE_STYLE}>{title}</h1>
      {body && <p style={CARD_BODY_STYLE}>{body}</p>}
      {banner != null && (
        <div role="alert" style={BANNER_STYLE}>
          {banner}
        </div>
      )}
      {children}
    </CenteredCard>
  );
}
