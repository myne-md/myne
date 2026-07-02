// Small, honest "Beta" tag for Labs / experimental surfaces (local-ai epic,
// ai-ux-surface MYND-408). No reusable badge primitive exists — the
// marketing-style `ComingSoonPill` was deliberately removed (MYND-130), so this
// is a restrained, token-styled label, NOT a hope pill. Used on the Settings
// rail (the AI entry, under the Labs group) and the AI panel header.
//
// The label text is i18n'd (`settings.ai.betaBadge`); it is chrome, not
// load-bearing trust copy — the privacy-sensitive AI copy stays in
// `load-bearing-copy.ts` and is rendered verbatim elsewhere.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

const BADGE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  marginLeft: "var(--space-2)",
  padding: "0 6px",
  height: 16,
  borderRadius: 4,
  border: "1px solid var(--line-1)",
  color: "var(--fg-3)",
  fontFamily: "var(--font-sans)",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  lineHeight: 1,
  flex: "0 0 auto",
};

export function BetaBadge({ testId }: { testId?: string }) {
  const { t } = useTranslation();
  return (
    <span data-testid={testId} style={BADGE_STYLE}>
      {t("settings.ai.betaBadge")}
    </span>
  );
}
