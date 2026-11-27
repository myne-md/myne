import type { CSSProperties } from "react";

/**
 * The Myne mark — rounded square + the "M" chevron. Themed: the square is ink,
 * the stroke is paper, so it inverts correctly between light and dark (matches
 * the account-number chip in the design: dark square on light, light on dark).
 */
export function MyneMark({ size = 28, radius }: { size?: number; radius?: number }) {
  const r = radius ?? Math.round(size * 0.19);
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ display: "block" }}>
      <rect width="32" height="32" rx={(r / size) * 32} fill="var(--ink-1)" />
      <path
        d="M8 22 V10 L16 18 L24 10 V22"
        stroke="var(--paper)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export type IconName =
  | "chevron-left"
  | "chevron-right"
  | "chevron-down"
  | "chevron-up"
  | "check"
  | "x"
  | "eye"
  | "eye-off"
  | "search"
  | "plus"
  | "clock"
  | "bookmark"
  | "lock"
  | "unlock"
  | "more-horizontal"
  | "more-vertical"
  | "copy"
  | "share"
  | "trash"
  | "folder"
  | "file-text"
  | "message-square"
  | "tag"
  | "star"
  | "settings"
  | "cloud"
  | "alert-triangle"
  | "info"
  | "face-id"
  | "fingerprint"
  | "mic"
  | "edit"
  | "arrow-left"
  | "arrow-right"
  | "download"
  | "link"
  | "columns-2"
  | "rotate-ccw"
  | "archive"
  // The action-sheet glyphs the desktop `ContextMenu` already draws
  // (myne-md/myne#1042). The `d` strings are the desktop registry's own
  // (`editor/src/host/lib/icons.ts`), so the same action is the same picture on
  // both clients — the reason the `archive` entry below spells its paths out too.
  | "file-plus"
  | "image-plus"
  | "folder-plus"
  | "palette";

// Stroke-based 24×24 paths (Lucide-style), drawn with currentColor so callers
// set colour via `color`. Matches the design's thin-stroke icon language.
const PATHS: Record<IconName, string> = {
  "chevron-left": "M15 18l-6-6 6-6",
  "chevron-right": "M9 18l6-6-6-6",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-up": "M6 15l6-6 6 6",
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18M6 6l12 12",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z|M12 15a3 3 0 100-6 3 3 0 000 6z",
  "eye-off": "M9.9 4.2A9.6 9.6 0 0112 4c6.5 0 10 7 10 7a14 14 0 01-2.3 3M6.6 6.6A14 14 0 002 11s3.5 7 10 7a9.6 9.6 0 003.4-.6|M3 3l18 18|M9.5 9.5a3 3 0 004 4",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16z|M21 21l-4.3-4.3",
  plus: "M12 5v14M5 12h14",
  // Clock face with hands (history) + bookmark ribbon (memory): the AI tab's
  // icon-only header buttons. Lucide stroke paths, same 24-grid language.
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18z|M12 7v5l3 2",
  bookmark: "M19 21l-7-4-7 4V5a2 2 0 012-2h10a2 2 0 012 2z",
  // Lucide `lock` / `lock-open`: a padlock BODY with a real shackle arc. These
  // two were a bare rectangle joined to an arc segment, and the rectangle's
  // sharp corners plus the disconnected arc is the "broken icon" the owner
  // flagged (2026-11-27 polish round) — on the Settings rows and the sidebar
  // footer they are the only lock-shaped glyph, so the defect was visible on
  // every screen that mentions locking.
  lock: "M5 11a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z|M8 9V7a4 4 0 0 1 8 0v2",
  unlock: "M5 11a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z|M8 9V7a4 4 0 0 1 7.5-2",
  // The dot trio: a zero-length `h.01` only draws under a round cap, so the
  // stroke cap is fixed here rather than left to the default.
  "more-horizontal": "M5 12h.01|M12 12h.01|M19 12h.01",
  "more-vertical": "M12 5h.01|M12 12h.01|M12 19h.01",
  // Lucide `copy`: two rounded sheets, the back one offset behind the front.
  copy: "M8 8a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2z|M16 6V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1",
  share: "M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7|M16 6l-4-4-4 4|M12 2v13",
  // Lucide `trash-2`: lid, handle, and the two inner lines. The old path drew a
  // bare trapezoid that read as a bucket, not a bin.
  trash: "M3 6h18|M8 6V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1|M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6|M10 11v6|M14 11v6",
  folder: "M4 5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 4.9A2 2 0 0 0 7.93 4H4z",
  // The two target glyphs the conversation lists use (myne-md/myne#848): a
  // note-anchored conversation, and one about the whole vault. Same lucide
  // paths as the desktop registry, so the two clients draw the same shape.
  "file-text":
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z|M14 2v4a2 2 0 0 0 2 2h4|M10 9H8|M16 13H8|M16 17H8",
  "message-square": "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  tag: "M3 3h7l11 11-7 7L3 10z|M7 7h.01",
  star: "M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.4 6.2 21.4l1.1-6.5L2.6 9.8l6.5-.9z",
  settings:
    "M12 15a3 3 0 100-6 3 3 0 000 6z|M19 12a7 7 0 00-.1-1.3l2-1.6-2-3.4-2.4 1a7 7 0 00-2.3-1.3L13.8 2h-3.6l-.4 2.4a7 7 0 00-2.3 1.3l-2.4-1-2 3.4 2 1.6A7 7 0 005 12a7 7 0 00.1 1.3l-2 1.6 2 3.4 2.4-1a7 7 0 002.3 1.3l.4 2.4h3.6l.4-2.4a7 7 0 002.3-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z",
  cloud: "M17.5 19H7a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.9 9.1 4.45 4.45 0 0 1 17.5 19z",
  "alert-triangle": "M12 3l9 16H3z|M12 9v5|M12 18h.01",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18z|M12 11v5|M12 8h.01",
  "face-id":
    "M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2|M9 10v1M15 10v1M12 9v3l-1 1M9.5 15a3.5 3.5 0 005 0",
  fingerprint:
    "M12 11a2 2 0 012 2v2a4 4 0 01-1 3|M8 14v1a6 6 0 01-1 3|M12 7a6 6 0 016 6v1|M6 13a6 6 0 012-4.5|M12 4a9 9 0 019 9",
  mic: "M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3z|M19 11a7 7 0 01-14 0|M12 18v3",
  edit: "M12 20h9|M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z",
  "arrow-left": "M19 12H5|M12 19l-7-7 7-7",
  "arrow-right": "M5 12h14|M12 5l7 7-7 7",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M7 10l5 5 5-5|M12 15V3",
  link: "M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1|M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1",
  "columns-2": "M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z|M12 3v18",
  // The sync glyph (Lucide `rotate-ccw`). The old string was two disjoint
  // fragments — an ellipse arc plus a corner tick — which rendered as the
  // "broken" mark the owner saw on the Sync row and in Settings → Data.
  "rotate-ccw": "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8|M3 3v5h5",
  // The Archive list's zero state (myne-md/myne#970 item 25). The desktop draws
  // Lucide's `archive`; this registry stores stroke `d` strings only, so the
  // box's rounded `<rect>` is expressed as its four sides. Same shape, same
  // 24-grid, so the two clients name the absent thing with the same glyph.
  archive: "M3 6h18|M8 6V4h8v2|M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8|M10 12h4",
  "file-plus":
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z|M14 2v4a2 2 0 0 0 2 2h4|M9 15h6|M12 18v-6",
  "image-plus":
    "M16 5h6|M19 2v6|M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5|m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21|M9 9h.01",
  "folder-plus":
    "M12 10v6|M9 13h6|M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  // Lucide's palette: the body plus five paint wells. The wells are drawn as tiny
  // circles, so each is a one-pixel dot rather than a filled shape — this registry
  // carries stroke `d` strings only, and a `d` can say `M13.5 6.5h.01`.
  palette:
    "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z|M13.5 6.5h.01|M17.5 10.5h.01|M8.5 7.5h.01|M6.5 12.5h.01",
};

export function Icon({
  name,
  size = 20,
  color = "currentColor",
  strokeWidth = 1.8,
  style,
  flip = false,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: CSSProperties;
  /** Mirror the glyph under RTL (via `[dir="rtl"] [data-flip]` in tokens.css).
   *  Set on DIRECTIONAL icons only — back / disclosure chevrons, nav arrows —
   *  never on symmetric ones (search, lock, …) or ones with their own rotation
   *  transform (the expand/collapse tree chevrons). */
  flip?: boolean;
}) {
  const segments = PATHS[name].split("|");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-flip={flip ? "" : undefined}
      style={{ display: "block", flexShrink: 0, ...style }}
    >
      {segments.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
