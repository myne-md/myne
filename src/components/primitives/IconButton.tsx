// Square, token-only icon button (MYND-137).
//
// A bare icon affordance — used for the sidebar collapse chevrons. Hover
// deepens the background `transparent → --paper-3` per the design canon
// (no transform, no color shift). Always carries an accessible label
// (mirrored to `title`) since it has no text.

import { type CSSProperties } from "react";
import { Icon } from "./Icon";
import type { IconName } from "../../lib/icons";
import { MIN_TARGET } from "./targetSize";

interface IconButtonProps {
  icon: IconName;
  /** Accessible label — used for both `aria-label` and the hover `title`. */
  label: string;
  onClick: () => void;
  /** Icon glyph size (px). Default 16. */
  iconSize?: number;
  /** Dim + disable the button (no hover, no click). Default false. */
  disabled?: boolean;
  /** E2E observability hook (`data-testid`), SYNC-8 curated-prop pattern. */
  testId?: string;
}

const ICON_BUTTON_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  ...MIN_TARGET,
  padding: 0,
  color: "var(--fg-3)",
  background: "transparent",
  border: 0,
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
};

export function IconButton({
  icon,
  label,
  onClick,
  iconSize = 16,
  disabled = false,
  testId,
}: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      style={{
        ...ICON_BUTTON_STYLE,
        ...(disabled ? { cursor: "not-allowed", opacity: 0.4 } : null),
      }}
      aria-label={label}
      title={label}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "var(--paper-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <Icon name={icon} size={iconSize} />
    </button>
  );
}
