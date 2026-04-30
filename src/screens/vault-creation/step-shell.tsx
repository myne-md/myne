// Layout primitives shared by every vault-creation step screen.
// Each step renders <StepLayout> as its outer frame and <StepHeading>
// + (optional) <StepEyebrow> for the title row. Consolidates the
// repeated wrapper / focus-management / eyebrow pattern flagged by
// the simplify pass.

import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "../../components/primitives/Icon";
import type { IconName } from "../../lib/icons";

interface StepLayoutProps {
  width?: number;
  align?: "stretch" | "center";
  gap?: number;
  children: ReactNode;
}

export function StepLayout({
  width = 420,
  align = "stretch",
  gap = 20,
  children,
}: StepLayoutProps) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-1)",
        padding: 24,
      }}
    >
      <div
        style={{
          width,
          display: "flex",
          flexDirection: "column",
          gap,
          alignItems: align === "center" ? "center" : "stretch",
        }}
      >
        {children}
      </div>
    </div>
  );
}

interface StepEyebrowProps {
  icon: IconName;
  children: ReactNode;
}

export function StepEyebrow({ icon, children }: StepEyebrowProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Icon name={icon} size={20} />
      <div
        style={{
          fontSize: 12,
          color: "var(--fg-3)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontWeight: 600,
        }}
      >
        {children}
      </div>
    </div>
  );
}

interface StepHeadingProps {
  centered?: boolean;
  children: ReactNode;
}

// Auto-focuses on mount so screen readers announce the new step.
// `tabIndex={-1}` makes the heading focusable programmatically without
// entering the Tab order; the .vc-step-heading class in tokens.css
// suppresses the focus ring on programmatic-only focus.
export function StepHeading({ centered, children }: StepHeadingProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      import.meta.env.DEV &&
      new URLSearchParams(location.search).get("test-no-autofocus") === "true"
    ) {
      return;
    }
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="vc-step-heading"
      style={{
        fontSize: 28,
        fontWeight: 600,
        letterSpacing: "-0.015em",
        lineHeight: 1.2,
        color: "var(--fg-display)",
        textAlign: centered ? "center" : "left",
      }}
    >
      {children}
    </div>
  );
}
