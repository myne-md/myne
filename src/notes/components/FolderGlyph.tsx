// `<FolderGlyph>` — renders a curated decorative folder icon (MYND-185) by
// name. Same inline-SVG + `dangerouslySetInnerHTML` pattern as the shared
// `Icon` primitive (the glyph strings are static, trusted lucide paths — never
// user input). `currentColor` stroke (PRODUCT.md: icons are never colored
// independently), strokeWidth matched to `FolderRow`'s default `FolderIcon`.

import type { CSSProperties } from "react";
import { FOLDER_ICON_PATHS } from "../folderIcons";

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
      dangerouslySetInnerHTML={{ __html: paths }}
    />
  );
}
