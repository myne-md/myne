import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

/**
 * Buttons — design-accurate geometry (h:52 primary/secondary, h:48 ghost,
 * r:6), colours from tokens so dark/amoled track automatically. UI-only:
 * `disabled` renders the 0.6-opacity state from the design but does nothing.
 */
export function Button({
  variant = "primary",
  full = true,
  children,
  style,
  ...rest
}: {
  variant?: Variant;
  full?: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const base = {
    height: variant === "ghost" ? 48 : 52,
    width: full ? "100%" : undefined,
    border: "none",
    borderRadius: 6,
    padding: "0 22px",
    fontFamily: "var(--font-sans)",
    fontSize: variant === "ghost" || variant === "secondary" ? 15 : 16,
    fontWeight: 600,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    opacity: rest.disabled ? 0.6 : 1,
  } as const;

  const skins = {
    primary: { background: "var(--accent)", color: "var(--accent-on)" },
    danger: { background: "var(--danger)", color: "#fff" },
    secondary: {
      background: "transparent",
      color: "var(--fg-2)",
      border: "1px solid var(--line-2)",
    },
    ghost: { background: "transparent", color: "var(--fg-1)", fontWeight: 500 as const },
  }[variant];

  return (
    <button {...rest} style={{ ...base, ...skins, ...style }}>
      {children}
    </button>
  );
}
