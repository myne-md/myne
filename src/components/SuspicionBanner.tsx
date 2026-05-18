// One-shot suspicion banner shown above the Unlock screen's password
// form when a force-relock path from the change-password modal carries
// a `Stage.unlock.suspicionReason` payload.
//
// Two flavors:
//   - `vault-meta-changed-externally` — red severity (delegates to
//     `DestructiveBanner`). Vault.meta was rewritten by another
//     instance (CAS mismatch); the user's slot was force-dropped.
//   - `vault-locked-during-change` — informational gray. The user
//     fired vault_lock during the change-password Argon2id window;
//     less severe than vault-changed (user-initiated, not external).
//
// LITERAL copy is pinned by `decisions.md` 2026-05-08
// "`Stage.unlock.suspicionReason?` field" entry.
//
// One-shot lifecycle: the banner renders whenever its `reason` prop is
// non-null. App.tsx clears `Stage.unlock.suspicionReason` implicitly
// when the user navigates away (stage exit) or completes a successful
// unlock. No explicit dismiss affordance — the unlock attempt itself
// is the "I see, I'm continuing" signal.

import type { CSSProperties } from "react";
import type { SuspicionReason } from "../lib/stage";
import { DestructiveBanner } from "./DestructiveBanner";

interface SuspicionBannerProps {
  reason: SuspicionReason;
}

const GRAY_STYLE: CSSProperties = {
  background: "var(--paper-2)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-4)",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
};

const COPY_FOR_REASON: Record<SuspicionReason, string> = {
  "vault-meta-changed-externally":
    "Vault was modified in another session — please unlock again.",
  "vault-locked-during-change":
    "Password change cancelled: vault was locked.",
};

export function SuspicionBanner({ reason }: SuspicionBannerProps) {
  const message = COPY_FOR_REASON[reason];
  if (reason === "vault-meta-changed-externally") {
    return <DestructiveBanner>{message}</DestructiveBanner>;
  }
  return (
    <div role="alert" style={GRAY_STYLE}>
      {message}
    </div>
  );
}
