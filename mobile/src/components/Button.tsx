import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

/**
 * Buttons.
 *
 * Appearance and every interactive state live in `@myne/client-core`'s
 * `components.css` under `.myne-btn`, which `mobile/src/main.tsx` already loads
 * and which the desktop `Button` renders through too. That means a press, a hover
 * and a focus ring are one implementation across both clients and cannot drift
 * apart, and it is where this button's press feedback came from: the file used to
 * hand-write its own skins with no hover, no press and no transition at all.
 *
 * This file is the semantic shell. It picks a variant and applies the one thing
 * that is a call-site decision, the full-width default.
 *
 * The touch GEOMETRY (52/48px, the larger type and gap) is mobile's own and lives
 * in `mobile/src/styles/tokens.css` as an override rather than here, so what a
 * button IS stays in the shared layer while how BIG it is stays in one stylesheet.
 */
export function Button({
  variant = "primary",
  full = true,
  children,
  className,
  style,
  ...rest
}: {
  variant?: Variant;
  full?: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      data-variant={variant}
      className={className === undefined ? "myne-btn" : `myne-btn ${className}`}
      // After `...rest`, so a caller's `style` still wins over the default width
      // the way it did before this component became a shell.
      style={{ width: full ? "100%" : undefined, ...style }}
    >
      {children}
    </button>
  );
}
