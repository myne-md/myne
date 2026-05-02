// Centered single-column card shell — shared by FailClosedError,
// Locked, and Unlock screens. Penpot canon: `screen------*` frames in
// page "4 — Desktop UI Kit"; all use the same envelope (centered card
// on `--bg-1` canvas, max-width 480, `--bg-2` fill + `--line-1`
// hairline + `--radius-2` + `--space-6` padding + `--space-4` row gap).

import type { CSSProperties, ReactNode } from "react";

interface CenteredCardProps {
  children: ReactNode;
}

const ROOT_STYLE: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--bg-1)",
  fontFamily: "var(--font-sans)",
  padding: "var(--space-6)",
};

const CARD_STYLE: CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-6)",
  maxWidth: 480,
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

export function CenteredCard({ children }: CenteredCardProps) {
  return (
    <div style={ROOT_STYLE}>
      <div style={CARD_STYLE}>{children}</div>
    </div>
  );
}

export const CARD_TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-2xl)",
  lineHeight: "var(--leading-snug)",
  letterSpacing: "var(--tracking-tight)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
  margin: 0,
};

export const CARD_BODY_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  fontWeight: "var(--weight-regular)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
  margin: 0,
};
