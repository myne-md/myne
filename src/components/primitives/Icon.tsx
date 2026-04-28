import type { CSSProperties } from "react";
import { ICON_PATHS, type IconName } from "../../lib/icons";

interface IconProps {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}

export function Icon({ name, size = 16, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
    />
  );
}
