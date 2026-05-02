// Vault locked screen — task 11 of `app-state-machine`.
// Mounted when Stage = `locked` (post-explicit-lock). Chrome matches
// `screen------unlock--idle` 1:1; only the title verb differs (state
// vs. invitation).

import type { CSSProperties } from "react";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
} from "../components/primitives/CenteredCard";

interface LockedProps {
  onUnlock: () => void;
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

export function Locked({ onUnlock }: LockedProps) {
  return (
    <CenteredCard>
      <h1 style={CARD_TITLE_STYLE}>Vault kilitli.</h1>
      <p style={CARD_BODY_STYLE}>Tekrar açmak için parolanı gir.</p>
      <button type="button" onClick={onUnlock} style={CTA_STYLE}>
        Aç
      </button>
    </CenteredCard>
  );
}
