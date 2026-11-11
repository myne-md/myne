// The monograms on the step-1 client cards (mcp external access access rework,
// myne-md/myne#1052).
//
// # Why these are letters and not logos
//
// An earlier version of this file inlined the vendors' own artwork: simple-icons
// paths, OpenCode's published favicon and a raster of Nous Research's crest, each
// painted in the brand's documented colour. That is a reproduction of somebody
// else's protected work, and neither the licence of an inlined path nor the
// "not affiliated" sentence next to it changes whose mark it is (myne-md/myne#183
// decided the same question the same way for the browser-extensions surface).
//
// A client's NAME is a reference, and the card already carries it as text. The
// monogram is drawn here from that name, so the bundle contains no vendor artwork
// at all and nothing needs a licence row.
//
// `aria-hidden` on the branch: the card's label is the accessible name.

import type { CSSProperties } from "react";

const BOX_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "var(--space-5)",
  height: "var(--space-5)",
  flexShrink: 0,
};

const MONOGRAM_STYLE: CSSProperties = {
  ...BOX_STYLE,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  letterSpacing: "0.02em",
  color: "var(--fg-2)",
};

/** The first letters of a client's name, which is what a monogram is. */
function monogram(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0] ?? "")
    .join("")
    .toUpperCase();
}

/** A client's monogram, drawn from its name. */
export function ClientMark({ name }: { name: string }) {
  return (
    <span style={MONOGRAM_STYLE} aria-hidden="true" data-testid="settings.mcp-client-monogram">
      {monogram(name)}
    </span>
  );
}
