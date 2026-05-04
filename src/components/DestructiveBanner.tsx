// Shared destructive-style banner — DRY anchor for error surfaces
// across `Unlock` (idle error), `PhraseEntryStep` (recover §3.4
// non-distinguishing), and `PasswordResetStep` (A8f failures). Wraps
// `<div role="alert">` with the canon destructive token palette
// (`--danger-soft` background + `--danger` border + `--danger` text).
//
// `recovery-flow.md` §3.4's "single non-distinguishing" rule binds the
// banner *text*, not the visual treatment — destructive styling is
// safe and consistent. Info-style banners (e.g., "kurtarma akışı
// yarıda kaldı" — informational, not user error) live separately and
// do not consume this component.

import type { CSSProperties, ReactNode } from "react";

interface DestructiveBannerProps {
  children: ReactNode;
}

const STYLE: CSSProperties = {
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-4)",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--danger)",
};

export function DestructiveBanner({ children }: DestructiveBannerProps) {
  return (
    <div role="alert" style={STYLE}>
      {children}
    </div>
  );
}
