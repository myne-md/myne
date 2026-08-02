import type { CSSProperties } from "react";
import { ICON_PATHS, type IconName } from "../../lib/icons";

interface IconProps {
  name: IconName;
  size?: number;
  /** Stroke width (default 1.5). Bump for small glyphs that read too thin
   *  (e.g. a checkmark inside a 16px checkbox). */
  strokeWidth?: number;
  style?: CSSProperties;
}

export function Icon({ name, size = 16, strokeWidth = 1.5, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
    />
  );
}
