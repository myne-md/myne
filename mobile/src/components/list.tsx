import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * iOS grouped list — inset card (r:26) with 52px rows and hairline separators.
 * The Android boards reuse the same structure with squarer corners; pass
 * `flush` for the Material full-bleed look.
 */
export function ListGroup({
  header,
  footer,
  children,
  flush = false,
  style,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div style={style}>
      {header && (
        <div
          style={{
            fontSize: 13,
            color: "var(--fg-3)",
            padding: "8px 20px 6px",
            letterSpacing: "-0.01em",
          }}
        >
          {header}
        </div>
      )}
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line-1)",
          borderRadius: flush ? 12 : 16,
          overflow: "hidden",
        }}
      >
        {children}
      </div>
      {footer && (
        <div style={{ fontSize: 13, color: "var(--fg-3)", padding: "8px 20px 0", lineHeight: 1.5 }}>
          {footer}
        </div>
      )}
    </div>
  );
}

export function ListRow({
  title,
  detail,
  leading,
  trailing,
  chevron = false,
  isLast = false,
  onClick,
  style,
}: {
  title: ReactNode;
  detail?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  isLast?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        minHeight: 52,
        padding: "0 16px",
        position: "relative",
        fontSize: 16,
        color: "var(--fg-1)",
        cursor: onClick ? "pointer" : "default",
        ...style,
      }}
    >
      {leading && <div style={{ marginInlineEnd: 12, display: "flex", flexShrink: 0 }}>{leading}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>{title}</div>
      {detail && <span style={{ color: "var(--fg-3)", marginInlineEnd: 6 }}>{detail}</span>}
      {trailing}
      {chevron && <Icon name="chevron-right" size={16} color="var(--line-3)" strokeWidth={2} flip />}
      {!isLast && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            insetInlineEnd: 0,
            insetInlineStart: leading ? 58 : 16,
            height: 1,
            background: "var(--line-1)",
          }}
        />
      )}
    </div>
  );
}
