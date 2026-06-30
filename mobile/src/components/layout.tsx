import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * Screen scaffolding. `<Screen>` is the device-filling surface (`.m-screen`);
 * `<ScreenScroll>` is the inner scroll region; the rest are the recurring
 * header / footer fragments the design uses on most flow screens.
 */

export function Screen({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="m-screen" style={style}>
      {children}
    </div>
  );
}

export function ScreenScroll({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="m-scroll" style={style}>
      {children}
    </div>
  );
}

/** Uppercase tracked section label (12px, 0.1em). */
export function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--fg-3)",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** The "Create a vault · 2 of 5" style flow header with a back chevron. */
export function FlowHeader({
  label,
  onBack,
  style,
}: {
  label: ReactNode;
  onBack?: () => void;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        flex: "none",
        padding: "56px 20px 0",
        display: "flex",
        alignItems: "center",
        gap: 12,
        ...style,
      }}
    >
      <button
        onClick={onBack}
        aria-label="Back"
        style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "flex" }}
      >
        <Icon name="chevron-left" size={18} color="var(--accent)" strokeWidth={2} />
      </button>
      <Eyebrow>{label}</Eyebrow>
    </div>
  );
}

/** Screen H1 (27px / 600 / -0.02em). */
export function Title({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <h1
      style={{
        margin: 0,
        fontSize: 27,
        lineHeight: 1.15,
        letterSpacing: "-0.02em",
        fontWeight: 600,
        color: "var(--fg-display)",
        ...style,
      }}
    >
      {children}
    </h1>
  );
}

/** Secondary body paragraph under a title. */
export function Lead({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <p
      style={{
        margin: "10px 0 0",
        fontSize: 15,
        lineHeight: 1.55,
        color: "var(--fg-2)",
        ...style,
      }}
    >
      {children}
    </p>
  );
}

/** Bottom action bar pinned to the foot of a flow screen (Back / Continue). */
export function FooterBar({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        flex: "none",
        padding: "14px 20px 40px",
        display: "flex",
        gap: 10,
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
