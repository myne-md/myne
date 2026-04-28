import { useState, type InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  mono?: boolean;
}

export function Input({
  invalid,
  mono,
  style,
  onFocus,
  onBlur,
  ...rest
}: InputProps) {
  const [focused, setFocused] = useState(false);

  const borderColor = invalid
    ? "var(--danger)"
    : focused
      ? "var(--accent)"
      : "var(--line-2)";

  return (
    <input
      {...rest}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={{
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontSize: mono ? 14 : 13,
        fontFeatureSettings: mono ? '"ss02","zero","calt"' : undefined,
        letterSpacing: mono ? "0.04em" : undefined,
        padding: "8px 10px",
        background: "var(--bg-1)",
        color: "var(--fg-1)",
        border: `1px solid ${borderColor}`,
        borderRadius: 3,
        outline: "none",
        boxShadow: focused
          ? "0 0 0 2px var(--bg-1), 0 0 0 4px var(--accent)"
          : "none",
        width: "100%",
        ...style,
      }}
    />
  );
}
