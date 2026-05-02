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
//   "Kilitle" — calls `vault_lock` (idempotent, even on empty slot)
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
        title: "Vault dosyası bozulmuş.",
        body: "Kurtarma akışı yakında. Şimdilik backup dosyandan vault'u manuel yerine koy.",
        cta: "Uygulamayı kapat",
      };
    case "io-error":
      return reason.ioKind === "PermissionDenied"
        ? {
            title: "Vault dosyasına erişim izni yok.",
            body: "Dosya izinlerini kontrol et.",
            cta: "Uygulamayı kapat",
          }
        : {
            title: "Vault dosyası okunamıyor.",
            body: "Disk veya dosya sistemi hatası olabilir.",
            cta: "Uygulamayı kapat",
          };
    case "invalid-state":
      return {
        title: "Beklenmeyen durum.",
        body: "Yeniden başlat.",
        cta: "Kilitle",
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
