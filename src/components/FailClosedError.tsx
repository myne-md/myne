// Shared fail-closed error UI — task 4 of `app-state-machine`.
//
// Three reasons, three CTA semantics:
//
// - `corrupted-vault`: vault.meta exists but failed `parse_vault_meta`
//   (magic / length / kdf_id / reserved-byte mismatch) at boot OR a
//   unlock attempt returned `InvalidVaultMeta`. CTA "Uygulamayı kapat"
//   only — NO welcome / unlock fallback (would risk a destructive
//   overwrite path; see `app-state-machine` PRD Q8(a)).
// - `io-error`: filesystem failure reading vault.meta (PermissionDenied,
//   NoSpace, Other). Same fail-closed UI, message varies by io_kind.
// - `invalid-state`: React state ↔ Rust slot disagreement detected at
//   component-mount reality check (Q5β-1 belt+suspenders). CTA
//   "Lock" — calls `vault_lock` (idempotent, even on empty slot)
//   then re-probes via `vault_status` and routes accordingly.
//
// NO diagnostic detail in prod (TB6: keep internal state model off
// the wire). SINGLE CTA per render — fail-closed contract.

import type { CSSProperties } from "react";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
} from "./primitives/CenteredCard";
import type { IoFailureKind } from "../lib/stage";

export type FailClosedReason =
  | { kind: "corrupted-vault" }
  | { kind: "io-error"; ioKind: IoFailureKind }
  | { kind: "invalid-state" };

interface FailClosedErrorProps {
  reason: FailClosedReason;
  onCtaClick: () => void;
}

interface ReasonCopy {
  title: string;
  body: string;
  cta: string;
}

function copyForReason(reason: FailClosedReason): ReasonCopy {
  switch (reason.kind) {
    case "corrupted-vault":
      return {
        title: "Vault file is corrupted.",
        body: "Recovery flow coming soon. For now, manually restore your vault from a backup file.",
        cta: "Close app",
      };
    case "io-error":
      return reason.ioKind === "PermissionDenied"
        ? {
            title: "No permission to access the vault file.",
            body: "Check file permissions.",
            cta: "Close app",
          }
        : {
            title: "Cannot read the vault file.",
            body: "This might be a disk or filesystem error.",
            cta: "Close app",
          };
    case "invalid-state":
      return {
        title: "Unexpected state.",
        body: "Please restart.",
        cta: "Lock",
      };
  }
}

const CTA_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  alignSelf: "flex-start",
  background: "var(--accent)",
  color: "var(--accent-on)",
  border: "none",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  cursor: "pointer",
};

export function FailClosedError({ reason, onCtaClick }: FailClosedErrorProps) {
  const copy = copyForReason(reason);
  return (
    <CenteredCard>
      <div role="alert" aria-live="assertive" style={{ display: "contents" }}>
        <h1 style={CARD_TITLE_STYLE}>{copy.title}</h1>
        <p style={CARD_BODY_STYLE}>{copy.body}</p>
        <button type="button" onClick={onCtaClick} style={CTA_STYLE}>
          {copy.cta}
        </button>
      </div>
    </CenteredCard>
  );
}
