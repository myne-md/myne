import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

type BannerKind = "danger" | "info" | "success" | "warning";

const BANNER: Record<BannerKind, { bg: string; fg: string; border?: string; icon: IconName }> = {
  danger: { bg: "var(--danger-soft)", fg: "var(--danger)", icon: "alert-triangle" },
  warning: { bg: "var(--warning-soft)", fg: "var(--warning)", icon: "alert-triangle" },
  info: { bg: "var(--bg-2)", fg: "var(--fg-2)", border: "var(--line-1)", icon: "info" },
  success: { bg: "var(--success-soft)", fg: "var(--success)", icon: "check" },
};

export function Banner({
  kind = "info",
  icon = true,
  children,
  style,
}: {
  kind?: BannerKind;
  icon?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const s = BANNER[kind];
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        background: s.bg,
        border: s.border ? `1px solid ${s.border}` : "none",
        borderRadius: 6,
        padding: "12px 14px",
        fontSize: 13,
        lineHeight: 1.5,
        color: s.fg,
        ...style,
      }}
    >
      {icon && <Icon name={s.icon} size={16} color={s.fg} style={{ marginTop: 1 }} />}
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

/** Auto-dismiss toast — design shows a floating pill near the bottom. */
export function Toast({
  children,
  icon,
  style,
}: {
  children: ReactNode;
  icon?: IconName;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "var(--ink-1)",
        color: "var(--paper)",
        borderRadius: 999,
        padding: "12px 18px",
        fontSize: 14,
        fontWeight: 500,
        boxShadow: "var(--shadow-3)",
        ...style,
      }}
    >
      {icon && <Icon name={icon} size={16} color="var(--paper)" />}
      {children}
    </div>
  );
}

export function Spinner({ size = 56, stroke = 4 }: { size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="myne-spinner">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-1)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c * 0.28} ${c}`}
      />
    </svg>
  );
}

/** Full-screen blocking progress (Argon2id encrypt/decrypt etc.). */
export function BlockingOverlay({
  title,
  subtitle,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--bg-1)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "0 40px",
        zIndex: 30,
      }}
    >
      <Spinner />
      <div style={{ marginTop: 26, fontSize: 18, fontWeight: 600, color: "var(--fg-1)" }}>{title}</div>
      {subtitle && (
        <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)", maxWidth: 260 }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}
