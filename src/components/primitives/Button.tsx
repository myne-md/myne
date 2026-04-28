import {
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: string;
  children?: ReactNode;
}

const baseStyle: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  padding: "7px 14px",
  borderRadius: 6,
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
    background: "var(--danger)",
    color: "#fff",
    borderColor: "var(--danger)",
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
      merged.background = "var(--paper-2)";
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
