// A titled group of related controls inside a settings panel (MYND-624).
//
// Every panel used to be one flat run of control blocks. That is readable at
// four rows and unreadable at nine: with nothing marking where one concern ends
// and the next begins, finding a setting means reading every label top to
// bottom, and the panel gives no sense of what it actually covers. MYND-536
// answered the same complaint with a search box, which helps when you know the
// name of what you want — this is the other half, for when you are looking to
// see what is there.
//
// Deliberately plain: a small uppercase heading in the panel's own type ramp
// and a hairline, not a card or a collapsible. The groups exist to let the eye
// skip, not to add chrome or another thing to click open. Nothing here is
// interactive, so nothing here can be in the wrong state.

import type { CSSProperties, ReactNode } from "react";

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
};

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
  whiteSpace: "nowrap",
};

// The rule runs to the panel edge so the heading reads as a divider rather than
// a label floating above unrelated rows.
const RULE_STYLE: CSSProperties = {
  flex: "1 1 auto",
  height: 1,
  background: "var(--line-1)",
};

const BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

export function SettingsSection({
  title,
  testId,
  children,
}: {
  title: string;
  /** Optional testid on the section root, for E2E to scope within a group. */
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section style={SECTION_STYLE} data-testid={testId} aria-label={title}>
      <div style={HEADER_STYLE}>
        <h3 style={TITLE_STYLE}>{title}</h3>
        <span style={RULE_STYLE} aria-hidden="true" />
      </div>
      <div style={BODY_STYLE}>{children}</div>
    </section>
  );
}
