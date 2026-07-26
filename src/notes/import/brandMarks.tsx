// Source brand marks for the import picker (MYND-586).
//
// INLINE SVG, deliberately. No remote asset, no icon-font, no CDN: the WebView CSP
// forbids external hosts, and a fetched logo would break the reproducible-build story
// for the sake of decoration. Each mark is a few hand-drawn paths sized to a 24
// viewBox, so the whole set costs a few hundred bytes and needs no dependency.
//
// TRADEMARK POSTURE. These marks identify WHAT the adapter reads — the same
// nominative use the epic already applies to the source NAMES (`decisions.md`
// 2026-07-25: "source names are used nominatively only, never productized as a Myne
// feature name"). They appear solely next to "import from X", never as Myne branding,
// never implying endorsement.
//
// FIDELITY, stated honestly: the Obsidian gem, the Notion monogram, and the HTML5
// shield are close to their real marks. The Evernote mark is a SIMPLIFIED stand-in
// (its elephant is not reproducible at this size by hand) — it leans on the brand
// green plus the folded-note motif for recognition. Dropping the official SVGs into
// `public/` and swapping the `path` data here is a clean follow-up if exact marks are
// wanted.

import type { ReactElement } from "react";
import type { ImportSourceId } from "./sourceCatalog";

/** Brand tile background + the mark's own fill, per source. */
export const BRAND_TINT: Readonly<Record<ImportSourceId, { bg: string; fg: string }>> = {
  // Obsidian purple.
  obsidian: { bg: "rgba(124, 58, 237, 0.14)", fg: "#8b5cf6" },
  // Notion is monochrome; use the neutral surface so it reads as black-on-white.
  notion: { bg: "rgba(255, 255, 255, 0.10)", fg: "var(--fg-1)" },
  // Evernote green.
  evernote: { bg: "rgba(0, 168, 45, 0.14)", fg: "#2ecc71" },
  // HTML5 orange.
  html: { bg: "rgba(227, 79, 38, 0.14)", fg: "#e8663d" },
  // Spreadsheet green.
  csv: { bg: "rgba(33, 115, 70, 0.16)", fg: "#3fb07a" },
};

function Svg({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      // Decorative: the adjacent text names the source.
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Obsidian — the faceted gem. */
function ObsidianMark(): ReactElement {
  return (
    <Svg>
      <path
        d="M13.4 2.2 7.1 6.0 4.2 13.6l4.3 7.6 7.6 1.0 3.7-6.2-2.4-8.6-4.0-5.2Z"
        fill="currentColor"
        opacity="0.28"
      />
      <path
        d="M13.4 2.2 7.1 6.0l2.6 6.2 6.4 3.8 3.3-2.8-2.4-8.6-3.6-2.4Z"
        fill="currentColor"
        opacity="0.62"
      />
      <path
        d="M9.7 12.2 4.2 13.6l4.3 7.6 7.6 1.0-.9-6.2-5.5-3.8Z"
        fill="currentColor"
      />
    </Svg>
  );
}

/** Notion — the monogram in a rounded frame. */
function NotionMark(): ReactElement {
  return (
    <Svg>
      <rect
        x="2.6"
        y="2.6"
        width="18.8"
        height="18.8"
        rx="3.4"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M8.4 16.6V7.4h1.9l4.4 6.0V7.4h1.6v9.2h-1.8l-4.5-6.2v6.2H8.4Z"
        fill="currentColor"
      />
    </Svg>
  );
}

/** Evernote — simplified: the folded note with the trunk curve. */
function EvernoteMark(): ReactElement {
  return (
    <Svg>
      <path
        d="M9.1 2.9h5.2l5.2 5.2v9.3a2.6 2.6 0 0 1-2.6 2.6H9.1a2.6 2.6 0 0 1-2.6-2.6V5.5a2.6 2.6 0 0 1 2.6-2.6Z"
        fill="currentColor"
        opacity="0.3"
      />
      <path d="M14.3 2.9l5.2 5.2h-5.2V2.9Z" fill="currentColor" />
      <path
        d="M10.2 10.4c1.9 0 2.6 1.1 2.6 2.6v2.3c0 1.3.8 2.1 2.1 2.1"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** HTML — the HTML5 shield. */
function HtmlMark(): ReactElement {
  return (
    <Svg>
      <path
        d="M4.0 2.7h16l-1.5 16.4L12 21.3l-6.5-2.2L4.0 2.7Z"
        fill="currentColor"
        opacity="0.28"
      />
      <path
        d="M12 5.9v2.0h4.6l-.2 2.0H12v2.0h4.2l-.3 3.1-3.9 1.2v2.1l5.6-1.7.9-10.7H12Z"
        fill="currentColor"
      />
      <path
        d="M12 5.9H6.6l.9 10.7 4.5 1.4v-2.1l-2.6-.8-.2-1.9H12v-2.0H9.0l-.2-2.0H12V5.9Z"
        fill="currentColor"
        opacity="0.72"
      />
    </Svg>
  );
}

/** CSV — a spreadsheet grid. */
function CsvMark(): ReactElement {
  return (
    <Svg>
      <rect
        x="3"
        y="4.4"
        width="18"
        height="15.2"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path d="M3 9.5h18" stroke="currentColor" strokeWidth="1.7" />
      <path d="M9.6 9.5v10.1" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3 14.6h18" stroke="currentColor" strokeWidth="1.3" opacity="0.6" />
    </Svg>
  );
}

const MARKS: Readonly<Record<ImportSourceId, () => ReactElement>> = {
  obsidian: ObsidianMark,
  notion: NotionMark,
  evernote: EvernoteMark,
  html: HtmlMark,
  csv: CsvMark,
};

/** The brand mark for one source, coloured by {@link BRAND_TINT}. */
export function BrandMark({ source }: { source: ImportSourceId }): ReactElement {
  const Mark = MARKS[source];
  return <Mark />;
}
