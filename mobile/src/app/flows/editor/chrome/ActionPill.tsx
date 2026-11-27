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
 *  Square rather than flexible: four equal squares read as a button row, while
 *  four stretched cells with an icon floating in the middle read as empty
 *  placeholders. */
export function ActionPill({ onClick, label, children, testid }: { onClick: () => void; label: string; children: ReactNode; testid?: string }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      aria-label={label}
      title={label}
      style={{
        // `--m-touch` is the canon's 44px floor; the extra 4px is the tile's own
        // breathing room, not a second target size.
        width: 48,
        height: 48,
        flex: "none",
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
