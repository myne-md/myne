import type { CSSProperties, ReactNode } from "react";
import { Icon, MyneMark, type IconName } from "./Icon";

/** Pill chip / tag. */
export function Chip({
  children,
  active = false,
  style,
}: {
  children: ReactNode;
  active?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: 999,
        padding: "7px 14px",
        fontSize: 13,
        fontWeight: 500,
        background: active ? "var(--accent-soft)" : "var(--bg-2)",
        border: `1px solid ${active ? "var(--accent)" : "var(--line-1)"}`,
        color: active ? "var(--accent)" : "var(--fg-2)",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** The account-number specimen chip (mark + monospace identifier). */
export function AccountNumber({
  value = "MY‑4F2A‑9C17‑8E2D‑1B5F‑K",
  style,
}: {
  value?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        background: "var(--bg-2)",
        border: "1px solid var(--line-1)",
        borderRadius: 8,
        padding: "12px 14px",
        ...style,
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 5,
          overflow: "hidden",
          display: "flex",
          flexShrink: 0,
        }}
      >
        <MyneMark size={24} radius={5} />
      </div>
      <span className="t-account-number" style={{ fontSize: 16 }}>
        {value}
      </span>
    </div>
  );
}

/** Floating action button (compose). */
export function Fab({ icon = "plus", style }: { icon?: IconName; style?: CSSProperties }) {
  return (
    <div
      style={{
        width: 56,
        height: 56,
        borderRadius: 18,
        background: "var(--accent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "var(--shadow-3)",
        ...style,
      }}
    >
      <Icon name={icon} size={26} color="var(--accent-on)" strokeWidth={2} />
    </div>
  );
}

/**
 * Bottom sheet — a scrim + rounded card sliding from the foot of the device.
 * Absolutely positioned inside the screen (`.m-screen` is the positioning
 * context). UI-only: the scrim doesn't dismiss.
 */
export function Sheet({
  children,
  grabber = true,
  padded = true,
  style,
}: {
  children: ReactNode;
  grabber?: boolean;
  padded?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, background: "rgba(0,0,0,0.4)" }} />
      <div
        style={{
          background: "var(--bg-1)",
          borderRadius: "20px 20px 0 0",
          padding: padded ? "10px 18px 34px" : "10px 0 34px",
          boxShadow: "var(--shadow-3)",
          ...style,
        }}
      >
        {grabber && (
          <div
            style={{
              width: 36,
              height: 5,
              borderRadius: 999,
              background: "var(--line-2)",
              margin: "0 auto 14px",
            }}
          />
        )}
        {children}
      </div>
    </div>
  );
}
