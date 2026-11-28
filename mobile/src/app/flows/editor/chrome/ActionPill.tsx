import type { ReactNode } from "react";

/** A create-action tile (New drawing / Template / Daily note / View) in the
 *  notes header.
 *
 *  **Icon-only since the 2026-11-27 polish round** (owner: "bunlarda title
 *  olmasına gerek yok, ikon only olsa yeterli"). The tile used to stack a 19px
 *  glyph over a 12px label, and at four columns on a phone every label was
 *  either truncated ("New d…", "Templ…") or squeezed, which is a caption nobody
 *  can read next to an icon everybody can. The label survives as the accessible
 *  name (`aria-label`) and the long-press/hover hint (`title`), so the meaning
 *  is still announced by VoiceOver and still available to a pointer.
 *
 *  Square rather than flexible: equal squares read as a button row, while cells
 *  stretched past their glyph read as empty placeholders. The row still has to
 *  FIT the width it is given — six tiles at a fixed 48 plus five 8pt gaps is
 *  328, which overflows a 360pt or narrower phone and clipped the last tile
 *  against the bezel (owner, 2026-11-27 round 4: "mobilde şunları width'e
 *  sığdır"). So the tile may shrink below 48 but never grows past it: on a wide
 *  phone the row looks exactly as it did, and on a narrow one the six share the
 *  space instead of running off the edge. */
export function ActionPill({ onClick, label, children, testid }: { onClick: () => void; label: string; children: ReactNode; testid?: string }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      aria-label={label}
      title={label}
      style={{
        // 48 is the preferred width (`--m-touch` 44 plus the tile's own breathing
        // room); `flex` lets a narrow row shrink all six evenly, and `maxWidth`
        // keeps a wide one from stretching them past their glyph.
        flex: "1 1 0",
        minWidth: 0,
        maxWidth: 48,
        height: 48,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--line-1)",
        borderRadius: 12,
        background: "transparent",
        color: "var(--fg-2)",
        padding: 0,
        cursor: "pointer",
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }} aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
