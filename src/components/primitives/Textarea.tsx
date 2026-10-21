// `<Textarea>` — the app's multi-line text field.
//
// The same skin as `<Input>` (`.myne-input` in `@myne/client-core`'s
// `components.css`), so a form with a single-line field and a multi-line one
// does not grow two visual languages. A separate primitive rather than a
// `multiline` flag on `Input` because the element type differs, and a flag would
// make every caller's ref and event types conditional.
//
// `resize: vertical` is the one property set here rather than in the shared
// sheet: a textarea is the only control where the user's own resize is a
// feature, and the primitive is the one place that decides it.

import { type Ref, type TextareaHTMLAttributes } from "react";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** Forwarded so a caller can focus or select inside the field. */
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ invalid, className, ref, style, ...rest }: TextareaProps) {
  return (
    <textarea
      ref={ref}
      {...rest}
      className={className === undefined ? "myne-input" : `myne-input ${className}`}
      data-invalid={invalid === true ? "true" : undefined}
      style={{ resize: "vertical", ...style }}
    />
  );
}
