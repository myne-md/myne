// `<FolderGlyph>` — renders a curated decorative folder icon (MYND-185 /
// MYND-516) by name. Lives in `src/components/` rather than under
// `src/app/flows/editor/decorations/` because it is no longer editor-scoped:
// `VaultMark` and the Settings vault-icon picker draw the same glyphs, and
// `src/components/` importing from `src/app/` would invert this tree's
// one-directional layering. (The `vite.config.ts` note that the presentational
// wrappers stay "mobile-local" is about cross-REPO sharing, not this move.)
// Mobile-local twin of the desktop `FolderGlyph` (same
// inline-SVG + `dangerouslySetInnerHTML` pattern — the glyph strings are
// static, trusted lucide paths, never user input), differing only in its
// default `size`. `currentColor` stroke (PRODUCT.md: icons are never colored
// independently). The glyph TABLE itself is shared cross-client via
// `@myne/decorations/folderIcons` — `folder_icons` is a synced prefs map, so
// both clients must resolve an assigned name to the same glyph.

import type { CSSProperties } from "react";
import { FOLDER_ICON_PATHS } from "@myne/decorations/folderIcons";

/**
 * Frozen `{__html}` objects, one per glyph — **identity, not immutability**
 * (myne-md/myne#894). React 19 compares `dangerouslySetInnerHTML` by object
 * identity, so a fresh literal per render re-assigns `innerHTML` and replaces
 * the nodes under it; the browser then fires no `click` when a mousedown and
 * mouseup straddle that render, which is a dead control rather than a slow one.
 * The glyph sits inside clickable folder rows, so it is on that path.
 * `src/components/primitives/Icon.tsx` carries the full account and the
 * measurement. Kept identical to the desktop twin.
 */
const FOLDER_INNER_HTML = new Map<string, { __html: string }>();
function folderInnerHtmlFor(paths: string): { __html: string } {
  let cached = FOLDER_INNER_HTML.get(paths);
  if (cached === undefined) {
    cached = { __html: paths };
    FOLDER_INNER_HTML.set(paths, cached);
  }
  return cached;
}

export function FolderGlyph({
  name,
  size = 18,
  style,
}: {
  name: string;
  size?: number;
  style?: CSSProperties;
}) {
  const paths = FOLDER_ICON_PATHS[name];
  if (paths === undefined) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      aria-hidden="true"
      dangerouslySetInnerHTML={folderInnerHtmlFor(paths)}
    />
  );
}
