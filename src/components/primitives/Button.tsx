import {
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { Icon } from "./Icon";
import type { IconName } from "../../lib/icons";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: IconName;
  children?: ReactNode;
  /** React 19: a function component takes `ref` as a prop; `...rest` puts it on the `<button>`. */
  ref?: Ref<HTMLButtonElement>;
}

const baseStyle: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  padding: "7px 14px",
  borderRadius: "var(--radius-2)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  transition:
    "background var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)",
  outline: "none",
  border: "1px solid transparent",
  lineHeight: 1.2,
};

const variantStyles: Record<ButtonVariant, CSSProperties> = {
  primary: {
    background: "var(--accent)",
    color: "var(--accent-on)",
    borderColor: "var(--accent)",
  },
  secondary: {
    background: "var(--bg-1)",
    color: "var(--fg-1)",
    borderColor: "var(--line-2)",
  },
  ghost: {
    background: "transparent",
    color: "var(--fg-2)",
  },
  danger: {
    // `--danger-solid` (a clear red fill), NOT the text-tuned `--danger` which
    // washes out to salmon as a button background on a dark theme.
    background: "var(--danger-solid)",
    color: "#fff",
    borderColor: "var(--danger-solid)",
  },
};

export function Button({
  variant = "secondary",
  icon,
  children,
  style,
  disabled,
  onMouseEnter,
  onMouseLeave,
  onMouseDown,
  onMouseUp,
  ...rest
}: ButtonProps) {
  const [hover, setHover] = useState(false);
  const [press, setPress] = useState(false);

  const merged: CSSProperties = { ...baseStyle, ...variantStyles[variant] };
  if (disabled) {
    merged.cursor = "not-allowed";
    merged.opacity = 0.6;
  } else {
    if (hover && variant === "primary") merged.background = "var(--accent-hover)";
    if (hover && (variant === "secondary" || variant === "ghost"))
      // `--bg-3` (the hover ramp), not `--paper-2` — the latter is imperceptible
      // on a near-black surface, so ghost/secondary buttons read as inert.
      merged.background = "var(--bg-3)";
    if (hover && variant === "danger")
      merged.background = "color-mix(in srgb, var(--danger-solid), black 14%)";
    if (press && variant === "primary") merged.background = "var(--accent-press)";
  }

  return (
    <button
      {...rest}
      disabled={disabled}
      style={{ ...merged, ...style }}
      onMouseEnter={(e) => {
        setHover(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setHover(false);
        setPress(false);
        onMouseLeave?.(e);
      }}
      onMouseDown={(e) => {
        setPress(true);
        onMouseDown?.(e);
      }}
      onMouseUp={(e) => {
        setPress(false);
        onMouseUp?.(e);
      }}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </button>
  );
}
