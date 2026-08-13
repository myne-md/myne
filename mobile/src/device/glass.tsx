import type { CSSProperties, ReactNode } from "react";

/**
 * iOS 26 "liquid glass" pill — blur + tint + inset shine.
 * Ported from the design bundle's ios-frame.jsx (IOSGlassPill). The tint/shine/
 * border/shadow flip with the theme via the --glass-* tokens in mobile.css.
 */
export function GlassPill({
  children,
  style = {},
}: {
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        height: 44,
        minWidth: 44,
        borderRadius: 9999,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "var(--glass-shadow)",
        ...style,
      }}
    >
      {/* blur + tint */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 9999,
          backdropFilter: "blur(12px) saturate(180%)",
          WebkitBackdropFilter: "blur(12px) saturate(180%)",
          background: "var(--glass-tint)",
        }}
      />
      {/* shine + hairline */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 9999,
          boxShadow: "var(--glass-shine)",
          border: "var(--glass-border)",
        }}
      />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          padding: "0 4px",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** A 36×36 icon slot inside a glass pill (nav back / ellipsis buttons). */
export function GlassIconButton({ children }: { children: ReactNode }) {
  return (
    <GlassPill>
      <div
        style={{
          width: 36,
          height: 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {children}
      </div>
    </GlassPill>
  );
}
