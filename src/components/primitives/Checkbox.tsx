// `<Checkbox>` — the tree's checkbox, painted rather than borrowed.
//
// **Why this exists** (myne-md/myne#1099). Every checkbox in the app used to be a
// raw `<input type="checkbox">` sized and skinned at its own call site, and that
// went wrong three ways at once:
//
//   * the attachments tiles and the memory-seed candidates sized the native box to
//     the pointer-target floor (24px) with `accentColor`, so the platform drew a
//     24px white box with a shadow at the card's corner and the tick read as an
//     enormous mark beside 12px text;
//   * `accentColor` colours the FILL, not the chrome, so the same call site looked
//     correct on one platform and like a foreign widget on another (the WebView
//     draws the box, the tick and the focus ring itself);
//   * `SelectToggle` already did the right thing — a `button role="checkbox"` —
//     for the saved-view projections, which may not contain an `<input>` at all,
//     so the tree had two answers to one question and the second one had to be
//     maintained.
//
// **A button, not an input**, for the reason `Switch` is one: the painted state and
// the announced state both come from `aria-checked`, so they cannot drift, and the
// component works inside the read-only saved-view renderers (SYNC-1).
//
// **The box keeps its painted size and the ROW carries the target.** The canon's
// interactive-surfaces rule: a control whose box IS what is drawn keeps its
// painted size and gets a transparent hit box around it. So the box is 16px, and
// the button around it is at least `--target-min` in both directions — which is
// what the native-input-era call sites got backwards.
//
// Appearance and every state live in `@myne/client-core`'s `components.css` under
// `.myne-checkbox` (the `myne-md/myne#773` rule: inline style is call-site
// geometry, never a component's skin).

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Icon } from "./Icon";

interface CheckboxProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "type"> {
  /** Current state — drives `aria-checked` and the painted box. */
  checked: boolean;
  /** Toggle handler. Omit (or pass `disabled`) to render the inert placeholder. */
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  /**
   * The accessible name, for a box with no visible label of its own (a tile's
   * corner, a list row's selector). Ignored when `children` are supplied: the
   * label text inside the control is part of its name.
   */
  ariaLabel?: string;
  /** `id` of the element describing this control (a helper line under the row). */
  ariaDescribedBy?: string;
  /** Optional `data-testid` for E2E targeting. */
  testId?: string;
  /** Visible label, rendered after the box. The whole row becomes the control. */
  children?: ReactNode;
  /** React 19: a function component takes `ref` as a prop. */
  ref?: Ref<HTMLButtonElement>;
}

export function Checkbox({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  ariaDescribedBy,
  testId,
  className,
  children,
  ref,
  ...rest
}: CheckboxProps) {
  const interactive = onChange !== undefined && !disabled;
  const labelled = children !== undefined;
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      role="checkbox"
      className={
        labelled
          ? className === undefined
            ? "myne-checkbox myne-checkbox--labelled"
            : `myne-checkbox myne-checkbox--labelled ${className}`
          : className === undefined
            ? "myne-checkbox"
            : `myne-checkbox ${className}`
      }
      aria-checked={checked}
      aria-disabled={!interactive}
      // `ariaLabel` is dropped when there is visible text: a button's own content
      // is its name, and two names is one too many (aria-label would win and the
      // visible text would stop matching what is announced).
      aria-label={labelled ? undefined : ariaLabel}
      aria-describedby={ariaDescribedBy}
      data-testid={testId}
      disabled={!interactive}
      onClick={interactive ? () => onChange(!checked) : undefined}
    >
      <span aria-hidden="true" className="myne-checkbox__box">
        {checked ? <Icon name="check" size={12} /> : null}
      </span>
      {children}
    </button>
  );
}
