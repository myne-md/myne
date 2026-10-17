// `<FolderGlyph>` — renders a curated decorative folder icon (MYND-185) by
// name. Same inline-SVG + `dangerouslySetInnerHTML` pattern as the shared
// `Icon` primitive (the glyph strings are static, trusted lucide paths — never
// user input). `currentColor` stroke (PRODUCT.md: icons are never colored
// independently), strokeWidth matched to `FolderRow`'s default `FolderIcon`.

import type { CSSProperties } from "react";
import { FOLDER_ICON_PATHS } from "../folderIcons";

/**
 * Frozen `{__html}` objects, one per glyph — **identity, not immutability**
 * (myne-md/myne#894). React 19 compares `dangerouslySetInnerHTML` by object
 * identity, so a fresh literal per render re-assigns `innerHTML` and replaces
 * the nodes under it; the browser then fires no `click` when a mousedown and
 * mouseup straddle that render, which is a dead control rather than a slow one.
 * The glyph sits inside clickable folder rows, so it is on that path.
 * `src/components/primitives/Icon.tsx` carries the full account and the
 * measurement. Kept identical to the mobile twin.
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
  size = 15,
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
