// The full-window updating surface (myne-md/myne#870).
//
// This is the screen the app becomes once the install has started. A Stage
// variant owns it rather than an overlay on the editor, for two reasons: the
// confirm before it locks the vault, which moves the Stage off `editor` and
// unmounts anything the editor was rendering, and the canon already has this
// idiom as a stage step rather than as an overlay
// (`src/components/BlockingProgressStep.tsx`, used by vault creation and by the
// recovery decrypt).
//
// The `working` phase carries the cipher moment: the version resolves once,
// staggered per glyph, and then settles. It is deliberately a ONE-SHOT inside
// `--duration-fast`, so it needs no entry in the motion guard's `infinite`
// allowlist and no `DURATION_EXEMPT` entry either. The multi-minute wait that
// follows is carried by `<Spinner>`, which is the animation the canon already
// admits for work in flight and the one that keeps moving under reduced motion.
//
// The `failed` phase states no cause, because the host cannot yet tell an
// install failure from a reachability failure (`myne-md/myne#864` widens that
// mapping). It offers the retry the current button already offers and the only
// honest way back, which is the unlock screen: the vault is locked by then.

import { useEffect, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { MyneMark } from "../components/primitives/MyneMark";
import { Spinner } from "../components/Spinner";
import { VISUALLY_HIDDEN } from "../components/primitives/visuallyHidden";
import { stageRootStyle } from "../components/primitives/stageRoot";

export type UpdatingPhase = "working" | "failed";

export interface UpdatingScreenProps {
  phase: UpdatingPhase;
  /** The version being installed, as the manifest reported it. */
  version: string;
  /** The failed phase's retry. */
  onRetry: () => void;
  /** The failed phase's exit. The vault is locked, so this lands on unlock. */
  onBackToUnlock: () => void;
}

const ROOT_STYLE: CSSProperties = {
  ...stageRootStyle,
  background: "var(--bg-1)",
  padding: "var(--space-5)",
};

const COLUMN_STYLE: CSSProperties = {
  maxWidth: 420,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--space-3)",
};

const EYEBROW_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--fg-3)",
  textAlign: "center",
  marginTop: "var(--space-3)",
};

const HEADING_STYLE: CSSProperties = {
  fontSize: "var(--text-2xl)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-tight)",
  lineHeight: 1.2,
  color: "var(--fg-1)",
  textAlign: "center",
};

const REVEAL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  letterSpacing: "var(--tracking-wide)",
  color: "var(--fg-3)",
};

const CAPTION_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  lineHeight: 1.6,
  color: "var(--fg-2)",
  textAlign: "center",
};

const HINT_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  lineHeight: 1.5,
  color: "var(--fg-3)",
  textAlign: "center",
  maxWidth: 320,
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  marginTop: "var(--space-4)",
};

/**
 * The version, resolving once.
 *
 * The glyphs are `aria-hidden` and the plain value sits beside them in a
 * visually-hidden span, so a screen reader reads a stable string instead of a
 * line that mutates glyph by glyph. The stagger is `--stagger-step` multiplied
 * by the index and CLAMPED at `--stagger-max`, which the token pair's own
 * contract requires ("multiply the step by the index, then clamp to the max").
 * The clamp is load-bearing here rather than defensive: this build ships a beta
 * channel, so `0.11.0-beta.1` is thirteen glyphs and would otherwise run 234ms
 * past the cap the token exists to enforce.
 */
function VersionReveal({ version }: { version: string }) {
  const { t } = useTranslation();
  const glyphs = Array.from(version);
  return (
    <div className="myne-version-reveal" style={REVEAL_STYLE}>
      {glyphs.map((glyph, index) => (
        <span
          // Index-disambiguated: a version carries the same dot twice.
          key={`${glyph}-${index}`}
          aria-hidden="true"
          style={{
            animationDelay: `min(calc(var(--stagger-step) * ${index}), var(--stagger-max))`,
          }}
        >
          {glyph}
        </span>
      ))}
      <span style={VISUALLY_HIDDEN}>
        {t("update.updating.version", { version })}
      </span>
    </div>
  );
}

export function UpdatingScreen({
  phase,
  version,
  onRetry,
  onBackToUnlock,
}: UpdatingScreenProps) {
  const { t } = useTranslation();
  const headingRef = useRef<HTMLSpanElement>(null);
  const failed = phase === "failed";

  // Move focus to the heading on mount so a screen reader announces the new
  // surface. Same pattern as `BlockingProgressStep`: `tabIndex={-1}` makes it
  // programmatically focusable without joining the Tab order.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div style={ROOT_STYLE} data-testid={failed ? "update.failed" : "update.updating"}>
      <div style={COLUMN_STYLE}>
        <MyneMark size={48} />
        {!failed && <Spinner size={28} />}
        <span style={EYEBROW_STYLE}>
          {failed ? t("update.failed.eyebrow") : t("update.updating.eyebrow")}
        </span>
        <span
          ref={headingRef}
          tabIndex={-1}
          style={HEADING_STYLE}
          className="vc-step-heading"
        >
          {failed ? t("update.failed.heading") : t("update.updating.heading")}
        </span>
        {!failed && <VersionReveal version={version} />}
        <span style={CAPTION_STYLE}>
          {failed
            ? // The RUNNING version, never the offered one: this line is read
              // after an update that did not install, and naming the version
              // that failed as the one installed is a false statement about the
              // machine the user is looking at.
              t("update.failed.caption", { version: __APP_VERSION__ })
            : t("update.updating.caption")}
        </span>
        <span style={HINT_STYLE}>
          {failed ? t("update.failed.hint") : t("update.updating.hint")}
        </span>
        {failed && (
          <div style={ACTIONS_STYLE}>
            <Button
              variant="ghost"
              onClick={onBackToUnlock}
              data-testid="update.failed-back"
            >
              {t("update.failed.back")}
            </Button>
            <Button
              variant="primary"
              onClick={onRetry}
              data-testid="update.failed-retry"
            >
              {t("update.failed.retry")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
