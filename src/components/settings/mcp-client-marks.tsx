// The marks on the step-1 client cards (mcp external access rework,
// myne-md/myne#1052).
//
// # Where these come from
//
// Real marks, inlined at build time: **simple-icons** (CC0) slugs `claude` for
// both Claude entries, `visualstudiocode` for VS Code and `cursor` for Cursor,
// plus OpenCode's own published favicon path. Nothing is fetched at runtime and no
// vendor SVG file enters the bundle.
//
// The colour is the brand's own documented value, not a theme token, and that is
// the ONE deliberate exception to the token ratchet in this tree: a brand mark
// drawn in `--accent` would be a false claim about whose mark it is. It sits
// inside a tinted tile so it does not depend on the surface behind it, and the
// card's label carries the identity when colour is unavailable.
//
// Hermes gets a monogram because there is no mark to use: Nous Research publishes
// only a 48x48 PNG, and simple-icons' `hermes` slug is the fashion house. A redrawn
// trademark would look finished and be wrong.
//
// `aria-hidden` on every branch: the card's label is the accessible name.

import type { CSSProperties } from "react";

import { NOUS_RESEARCH_BADGE } from "./mcp-client-mark-images";

/** A mark's path data plus the brand colour it is drawn in. */
interface Mark {
  readonly path: string;
  /** The vendor's own colour for a path mark, and the ink for a stencil. Omitted
   *  means the theme's foreground. */
  readonly brand?: string;
  /** The artwork's own coordinate box. Defaults to simple-icons' 24. A vendor
   *  asset keeps its native box rather than being rescaled by hand. */
  readonly viewBox?: string;
  /** Some artworks are a frame with a hole in it, which needs even-odd to read
   *  as one shape. */
  readonly fillRule?: "evenodd" | "nonzero";
  /** A raster mark (data URI) for a vendor that publishes no vector. */
  readonly image?: string;
}

const MARKS: Record<string, Mark> = {
  // simple-icons `claude`, the product mark both Claude entries share.
  claude: {
    brand: "#D97757",
    path: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  },
  // simple-icons `cursor` (v15). The mark is monochrome in the vendor's own
  // treatment, so the "brand colour" here is the light it is drawn in on a dark
  // surface rather than a hue, and painting it in a token would be the same false
  // claim in the other direction.
  cursor: {
    brand: "#EDEDED",
    path: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  },
  // OpenCode publishes no simple-icons entry, so this is the frame path from its
  // own favicon (opencode.ai/favicon.svg, read 2026-11-10), in that file's
  // 512 box. The favicon's second path is the grey inner square, dropped: one
  // path reads as the mark and keeps the inline weight down.
  opencode: {
    brand: "#FFFFFF",
    viewBox: "0 0 512 512",
    fillRule: "evenodd",
    path: "M384 416H128V96H384V416ZM320 160H192V352H320V160Z",
  },
  // Nous Research's crest, for the Hermes card: no vector exists at a size that
  // reads, so the raster above carries it.
  nousresearch: {
    image: NOUS_RESEARCH_BADGE,
    path: "",
  },
  // simple-icons `visualstudiocode`.
  visualstudiocode: {
    brand: "#007ACC",
    path: "M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z",
  },
};

// No tile: the card is already the rectangle, so a box inside a box drew twice.
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

/**
 * A client's mark where one exists, its monogram otherwise.
 *
 * The tile behind a real mark is tinted with the brand colour at low alpha rather
 * than filled, so a light brand colour stays legible on a dark surface and the card
 * keeps its own background.
 */
export function ClientMark({ mark, name }: { mark: string | null; name: string }) {
  const entry = mark === null ? undefined : MARKS[mark];
  if (entry === undefined) {
    return (
      <span style={MONOGRAM_STYLE} aria-hidden="true" data-testid="settings.mcp-client-monogram">
        {monogram(name)}
      </span>
    );
  }
  if (entry.image !== undefined) {
    // A raster mark is a single-colour stencil, so it is painted with the mask
    // rather than shown as an image: the ink follows the theme instead of staying
    // black on a dark card (`myne-md/myne#1052`).
    const mask = {
      maskImage: `url(${entry.image})`,
      WebkitMaskImage: `url(${entry.image})`,
      maskSize: "contain",
      WebkitMaskSize: "contain",
      maskRepeat: "no-repeat",
      WebkitMaskRepeat: "no-repeat",
      maskPosition: "center",
      WebkitMaskPosition: "center",
    } as CSSProperties;
    return (
      <span
        style={{ ...BOX_STYLE, ...mask, backgroundColor: entry.brand ?? "var(--fg-1)" }}
        aria-hidden="true"
        data-testid="settings.mcp-client-mark"
      />
    );
  }
  return (
    <span
      style={{ ...BOX_STYLE, color: entry.brand ?? "var(--fg-1)" }}
      aria-hidden="true"
      data-testid="settings.mcp-client-mark"
    >
      <svg
        width="18"
        height="18"
        viewBox={entry.viewBox ?? "0 0 24 24"}
        fill="currentColor"
        fillRule={entry.fillRule ?? "nonzero"}
        clipRule={entry.fillRule ?? "nonzero"}
      >
        <path d={entry.path} />
      </svg>
    </span>
  );
}
