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
      dangerouslySetInnerHTML={{ __html: paths }}
    />
  );
}
