import type { CSSProperties } from "react";
import { ICON_PATHS } from "../../lib/icons";

interface IconProps {
  name: string;
  size?: number;
  style?: CSSProperties;
}

export function Icon({ name, size = 16, style }: IconProps) {
  const path = ICON_PATHS[name];
  if (!path) return null;
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
      dangerouslySetInnerHTML={{ __html: path }}
    />
  );
}
