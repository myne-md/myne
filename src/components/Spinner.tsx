// Circular CSS-only spinner for the EncryptingStep + AccountStep "Saving…"
// inline state. Animation lives in tokens.css (`@keyframes myne-spinner-rotate`).
// Under `prefers-reduced-motion: reduce`, tokens.css's global rule forces
// `animation-duration: 0ms` — the spinner renders as a static ring (border-top
// accent), an honest "work-in-progress" indicator without rotation.

import type { CSSProperties } from "react";

interface SpinnerProps {
  size?: number;
  style?: CSSProperties;
}

export function Spinner({ size = 32, style }: SpinnerProps) {
  const borderWidth = Math.max(2, Math.round(size / 12));
  return (
    <div
      className="myne-spinner"
      role="status"
      aria-label="Loading"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: `${borderWidth}px solid var(--line-1)`,
        borderTopColor: "var(--accent)",
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
