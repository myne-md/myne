// `<Input>` — the app's single-line text field.
//
// Appearance and every state live in `@myne/client-core`'s `components.css`
// under `.myne-input` (myne-md/myne#773). The React `focused` state this file
// used to carry existed only to fake `:focus` from an inline style, and it is
// gone: the focus border and ring are now a `:focus` rule.
//
// `:focus` rather than `:focus-visible`, deliberately. A text field that has
// been clicked into IS focused and must say so — the caret alone is too quiet
// to locate a field in a dense form, and a pointer-initiated focus on a text
// input is precisely the case `:focus-visible` excludes.
//
// A caller's `style` still wins, so the mono account-number fields and the
// width-constrained ones keep their call-site layout unchanged.

import { type InputHTMLAttributes, type Ref } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  mono?: boolean;
  /** Forwarded to the underlying `<input>`, so a caller that focuses or selects
   *  the field directly (the saved-views search) can keep using the primitive. */
  ref?: Ref<HTMLInputElement>;
}

export function Input({ invalid, mono, className, ref, ...rest }: InputProps) {
  return (
    <input
      ref={ref}
      {...rest}
      className={className === undefined ? "myne-input" : `myne-input ${className}`}
      data-mono={mono === true ? "true" : undefined}
      data-invalid={invalid === true ? "true" : undefined}
    />
  );
}
