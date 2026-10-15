// SPDX-License-Identifier: AGPL-3.0
// The protected recovery-phrase grid: blurred until revealed, re-blurred the
// moment the user walks away.
//
// Extracted from `SecretPhraseReveal` (myne-md/myne#468). The recovery kit shows
// the phrase beside the account number and exports BOTH as one file, so it needs
// the grid and its display protections WITHOUT the phrase-only Copy/Save row
// that used to be welded to them. `SecretPhraseReveal` still composes this plus
// that row, so the identity dialog's surface is unchanged.
//
// `dir="ltr"` on the grid is a correctness fix, not typography. The ORDER of the
// words is part of the secret, `recovery-flow.md` §2.4 commits to never showing
// them again, and a grid laid out right-to-left under an RTL locale hands the
// user a transcription whose wrongness is undiscoverable: BIP-39's checksum
// misses a permutation, so the phrase simply fails to open the vault, months
// later, with nothing to compare against. The page stays in the locale's own
// direction; only the grid and the type-back inputs are pinned.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./primitives/Icon";

export interface PhraseGridProps {
  /** The words, already split. */
  phrase: readonly string[];
  /** Whether the grid shows its words or is blurred. Owner-held, so a caller can
   *  re-hide it for its own reasons (the vault flow's reducer does). */
  revealed: boolean;
  /** Called when the user asks to reveal, and when a walk-away hides it again. */
  onReveal: () => void;
  onHide: () => void;
  /** Testid stem: grid `<stem>-grid`, words `<stem>-word`, reveal `<stem>-reveal`. */
  testIdPrefix: string;
  /**
   * Exact grid testid, overriding `<stem>-grid`. Exists for the identity dialog,
   * whose E2E addresses the bare `identity-setup.phrase` on the grid element.
   */
  gridTestId?: string;
  /** Words per row. The kit sheet is narrower than the standalone phrase screen. */
  columns?: number;
}

export function PhraseGrid({
  phrase,
  revealed,
  onReveal,
  onHide,
  testIdPrefix,
  gridTestId,
  columns = 4,
}: PhraseGridProps) {
  const { t } = useTranslation();

  // Re-blur when the user Cmd-Tabs or the OS hides the window. Two events,
  // because one does not observe the same user action on both platforms
  // (`recovery-flow.md` §2.2 as amended): `blur` catches an app switch and a
  // screen lock on a desktop window, while a browser's most common walk-away is
  // a TAB switch, which `visibilitychange` reports and `blur` may not. Both are
  // registered on both clients; the inert one costs a listener.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    window.addEventListener("blur", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [onHide]);

  return (
    <div style={{ position: "relative" }}>
      <div
        dir="ltr"
        data-testid={gridTestId ?? `${testIdPrefix}-grid`}
        data-revealed={revealed}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          // Tokens rather than the literal `6` the two `gap`s carried before the
          // extraction: an inline-style literal outranks every stylesheet, so it
          // is unreachable to any custom theme, permanently. 8px between chips
          // and 4px inside one are the nearest scale steps, and the second is
          // tighter than it was, which reads better on a number-word pair.
          gap: "var(--space-2)",
          padding: "var(--space-4)",
          background: "var(--paper-2)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-2)",
          filter: revealed ? "none" : "blur(8px)",
          transition: "filter var(--duration-base) var(--ease-standard)",
          userSelect: revealed ? "text" : "none",
        }}
      >
        {phrase.map((word, i) => (
          <div
            key={i}
            data-testid={`${testIdPrefix}-word`}
            data-index={i + 1}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "var(--space-1)",
              padding: "6px 10px",
              background: "var(--bg-1)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-1)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              fontFeatureSettings: '"ss02","zero","calt"',
            }}
          >
            <span style={{ color: "var(--fg-3)", minWidth: 18, textAlign: "end" }}>
              {i + 1}
            </span>
            <span style={{ color: "var(--fg-1)" }}>{word}</span>
          </div>
        ))}
      </div>
      {!revealed && (
        // A raw `<button>` rather than `<Button>`, deliberately, and this comment
        // is what `check-primitive-adoption.mjs` asks for at such a call site: it
        // is not a control with a label, it is the full-bleed hit area over the
        // blurred grid, absolutely positioned and transparent, with a pill drawn
        // inside it. A primitive would bring its own padding, radius, background
        // and focus ring, all of which would have to be overridden away.
        <button
          type="button"
          onClick={onReveal}
          data-testid={`${testIdPrefix}-reveal`}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: 0,
            cursor: "pointer",
            color: "var(--fg-1)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-medium)",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "8px 14px",
              background: "var(--bg-1)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--radius-2)",
            }}
          >
            <Icon name="eye" size={14} />
            {t("vaultCreation.phrase.reveal")}
          </span>
        </button>
      )}
    </div>
  );
}
