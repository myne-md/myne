// Layout primitives shared by every vault-creation step screen.
// Each step renders <StepLayout> as its outer frame and <StepHeading>
// + (optional) <StepEyebrow> for the title row. Consolidates the
// repeated wrapper / focus-management / eyebrow pattern flagged by
// the simplify pass.

import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "../../components/primitives/Icon";
import type { IconName } from "../../lib/icons";
import { stageRootStyle } from "../../components/primitives/stageRoot";
import { scrollRegionStyle, useScrollEdges } from "../../hooks/useScrollEdges";

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
  const { ref, fadeProps } = useScrollEdges<HTMLDivElement>();
  return (
    <div
      style={{
        ...stageRootStyle,
        background: "var(--bg-1)",
        padding: "var(--space-5)",
      }}
    >
      <div
        ref={ref}
        {...fadeProps}
        style={{
          width,
          display: "flex",
          flexDirection: "column",
          gap,
          alignItems: align === "center" ? "center" : "stretch",
          // Bounded and scrollable, because `stageRootStyle` bounds the ROOT.
          // Before that, `min-height: 100vh` let the box grow to fit and overflow
          // ran off the bottom only, so the top of the step stayed on screen.
          // A capped root with `alignItems: center` pushes a too-tall column out
          // of BOTH ends instead, and these are the tallest surfaces in the tree:
          // on a short window the recovery-phrase display and the password step
          // lose their heading and their Continue button at once, with no way to
          // reach either. Same pair `CenteredCard` and `VaultPicker` got.
          ...scrollRegionStyle,
          maxHeight: "100%",
        }}
      >
        {children}
      </div>
    </div>
  );
}

interface StepEyebrowProps {
  /** Optional leading glyph. Omitted by steps whose tone forbids an icon
   *  (e.g. the first-run safety briefing — an alarm glyph would read as a
   *  warning, MYND-114). */
  icon?: IconName;
  /** Mount marker for E2E (curated-prop testid discipline, src/CLAUDE.md). */
  testId?: string;
  children: ReactNode;
}

export function StepEyebrow({ icon, testId, children }: StepEyebrowProps) {
  return (
    <div
      data-testid={testId}
      style={{ display: "flex", alignItems: "center", gap: 10 }}
    >
      {icon && <Icon name={icon} size={20} />}
      <div
        style={{
          fontSize: 12,
          color: "var(--fg-3)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontWeight: "var(--weight-semibold)",
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
        fontSize: "var(--text-2xl)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "-0.015em",
        lineHeight: 1.2,
        color: "var(--fg-display)",
        textAlign: centered ? "center" : "start",
      }}
    >
      {children}
    </div>
  );
}
