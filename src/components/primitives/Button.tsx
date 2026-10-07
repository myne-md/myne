// `<Button>` — the app's text button, in four variants.
//
// Appearance and every interactive state live in `@myne/client-core`'s
// `components.css` under `.myne-btn` (myne-md/myne#773). This file is the
// semantic shell: it picks a variant, renders an optional leading glyph, and
// forwards everything else to the `<button>`.
//
// It used to track `hover` and `press` in React state and rebuild an inline
// style object per render, because an inline style cannot express `:hover` or
// `:active`. Two things were wrong with that beyond the duplication. A
// `mousedown`-driven press never fired for a keyboard user (`:active` does, on
// Space and Enter), and the press feedback had been wired for the primary
// variant only, so the other three answered a click with nothing until the
// handler returned. Both are fixed by the move rather than by this file.
//
// A caller's `style` still wins on specificity — deliberately, so layout stays
// at the call site and migrating a call site is never all-or-nothing.

import {
  type ButtonHTMLAttributes,
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

export function Button({
  variant = "secondary",
  icon,
  children,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      data-variant={variant}
      className={className === undefined ? "myne-btn" : `myne-btn ${className}`}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </button>
  );
}
