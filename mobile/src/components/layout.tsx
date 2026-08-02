import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";

/**
 * Screen scaffolding. `<Screen>` is the device-filling surface (`.m-screen`);
 * `<ScreenScroll>` is the inner scroll region; the rest are the recurring
 * header / footer fragments the design uses on most flow screens.
 */

/** Top padding for a full-page tab header — clears the notch / status bar
 *  (safe-area-inset-top with a 60px floor for the gallery). Shared by the
 *  list, Search, Graph, Files, and Templates pages so their titles align. */
export const LIST_TOP = "max(60px, calc(env(safe-area-inset-top) + 12px))";

export function Screen({
  children,
  style,
  ref,
}: {
  children: ReactNode;
  style?: CSSProperties;
  /** Optional handle to the screen element (for view-transition animations). */
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={ref} className="m-screen" style={style}>
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

/** Centered phone-width column for the single-column flows (welcome / create /
 *  unlock / recover / picker / restore-backup). On phones (viewport ≤ 480px)
 *  this is a no-op; on tablets it keeps those flows a sane centered column
 *  instead of stretching edge to edge. The editor renders bare — it is the
 *  adaptive multi-pane surface (SizeClassContext). */
export function PhoneColumn({ children }: { children: ReactNode }) {
  return (
    <div style={{ height: "100%", width: "100%", maxWidth: 480, margin: "0 auto" }}>
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
  const { t } = useTranslation();
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
        aria-label={t("common.back")}
        style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "flex" }}
      >
        <Icon name="chevron-left" size={18} color="var(--accent)" strokeWidth={2} flip />
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

/** Bottom action bar pinned to the foot of a flow screen (Back / Continue).
 *
 *  The bottom padding is enforced by the component (applied AFTER the caller's
 *  `style`, so a `padding` shorthand override can't accidentally clip it): it
 *  always clears the home indicator via `env(safe-area-inset-bottom)` on device,
 *  or a 34px floor in the gallery where env() resolves to 0. This is why callers
 *  never need to hand-tune a bottom value — every footer stays off the rounded
 *  bottom corner on all devices. */
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
        padding: "14px 20px",
        display: "flex",
        gap: 10,
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        ...style,
        paddingBottom: "max(34px, calc(14px + env(safe-area-inset-bottom, 0px)))",
      }}
    >
      {children}
    </div>
  );
}
