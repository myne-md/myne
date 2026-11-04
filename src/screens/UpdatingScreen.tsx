// The full-window updating surface (myne-md/myne#870, redesigned in #1020).
//
// This is the screen the app becomes once the install has started. A Stage
// variant owns it rather than an overlay on the editor, for two reasons: the
// confirm before it locks the vault, which moves the Stage off `editor` and
// unmounts anything the editor was rendering, and the canon already has this
// idiom as a stage step rather than as an overlay
// (`src/components/BlockingProgressStep.tsx`, used by vault creation and by the
// recovery decrypt).
//
// **The redesign, and what it was for.** The first version stacked seven lines: a
// marker, a spinner, an eyebrow, a heading, a cipher version reveal, a caption and
// a hint, three of which said the same thing, and none of which said what was
// actually happening while minutes went by. What is here now is one readout with
// four rows and no repetition: the version (the cipher moment, kept, now part of
// the readout instead of a block above it), a determinate bar, the phase word with
// its percentage, and one detail line that reports what the host is really doing
// (bytes arriving, then the signature check, then the install). The state comes
// from host events rather than from copy (`update_install` streams them; see
// `src-tauri/src/plugins/update`), so the bar is a measurement and not an
// animation standing in for one.
//
// The cipher moment stays a ONE-SHOT inside `--duration-fast`, staggered per glyph
// and clamped, so it needs no entry in the motion guard's `infinite` allowlist and
// no `DURATION_EXEMPT` entry either. The one loop on this screen is the
// indeterminate bar, admitted by name because an origin that sends no
// `Content-Length` gives the host no total to measure against and a frozen 0%
// reads as hung (the same argument MYND-630 records for the spinner).
//
// The `failed` phase states no cause, because the host cannot yet tell an install
// failure from a reachability failure (`myne-md/myne#864` widens that mapping). It
// offers the retry the current button already offers and the only honest way back,
// which is the unlock screen: the vault is locked by then.

import { useEffect, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { MyneMark } from "../components/primitives/MyneMark";
import { VISUALLY_HIDDEN } from "../components/primitives/visuallyHidden";
import { stageRootStyle } from "../components/primitives/stageRoot";
import { formatBytes } from "../components/attachments/format";
import type { UpdateProgressState } from "../hooks/useUpdateAvailable";

export type UpdatingPhase = "working" | "failed";

export interface UpdatingScreenProps {
  phase: UpdatingPhase;
  /** The version being installed, as the manifest reported it. */
  version: string;
  /**
   * Where the install has got to, from the host's progress events. `null` before
   * the first tick, which is the same shape as `starting`; the prop is nullable so
   * a story or a test can render the screen with no host behind it.
   */
  progress?: UpdateProgressState | null;
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
  maxWidth: 360,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--space-3)",
};

const EYEBROW_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "center",
  gap: "var(--space-2)",
  marginTop: "var(--space-3)",
};

const EYEBROW_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const REVEAL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  letterSpacing: "var(--tracking-wide)",
  color: "var(--fg-2)",
};

const HEADING_STYLE: CSSProperties = {
  fontSize: "var(--text-2xl)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-tight)",
  lineHeight: 1.2,
  color: "var(--fg-1)",
  textAlign: "center",
};

const STATUS_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "center",
  gap: "var(--space-2)",
  width: "100%",
};

const STATUS_STYLE: CSSProperties = {
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-1)",
};

/** The one number on the screen that a reader is looking for, so it is mono. */
const PERCENT_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const DETAIL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  marginTop: "calc(-1 * var(--space-2))",
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
  maxWidth: 300,
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
 * line that mutates glyph by glyph. The stagger is `--stagger-step` multiplied by
 * the index and CLAMPED at `--stagger-max`, which the token pair's own contract
 * requires ("multiply the step by the index, then clamp to the max"). The clamp is
 * load-bearing rather than defensive: this build ships a beta channel, so
 * `0.11.0-beta.1` is thirteen glyphs and would otherwise start its last glyph
 * 216ms in.
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

/**
 * How much of the artifact is here, as a 0-1 fraction, or `null` when the host has
 * no denominator.
 *
 * `null` is the honest answer for an origin that sent no `Content-Length`, and it
 * is what picks the indeterminate bar. The two later phases are 1 by construction:
 * the bytes are all here before either of them begins.
 */
function fractionOf(progress: UpdateProgressState | null): number | null {
  if (progress === null) return null;
  switch (progress.phase) {
    case "downloading":
      return progress.total !== null && progress.total > 0
        ? Math.min(1, progress.downloaded / progress.total)
        : null;
    case "verifying":
    case "installing":
      return 1;
    default:
      return null;
  }
}

/** The progress bar. Determinate when the host reported a total, sweeping when not. */
function ProgressBar({
  progress,
  fraction,
}: {
  progress: UpdateProgressState | null;
  fraction: number | null;
}) {
  const { t } = useTranslation();
  // Floor rather than round, so the readout cannot say 100% while bytes are still
  // arriving. The bar itself is allowed to reach the end.
  const percent = fraction === null ? null : Math.floor(fraction * 100);
  return (
    <div
      className="myne-update-progress-track"
      style={{ width: "100%" }}
      role="progressbar"
      aria-label={t("update.updating.progressLabel")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent === null ? undefined : percent}
      // The percentage is drawn beside the bar as text, so a screen reader that
      // reaches this element gets the same number twice. The label names what the
      // bar measures; `aria-valuenow` is the value.
      data-testid="update.progress"
    >
      {percent === null ? (
        <div
          className="myne-update-progress-fill myne-update-progress-indeterminate"
          data-motion="essential"
        />
      ) : (
        <div className="myne-update-progress-fill" style={{ width: `${percent}%` }} />
      )}
      {/* One announcement per PHASE, not per tick: a live region on the byte
          readout would read out a changing number a hundred times and the phase is
          the only thing that changes meaningfully. */}
      <span style={VISUALLY_HIDDEN} aria-live="polite">
        {progress === null ? "" : t(`update.phase.${progress.phase}`)}
      </span>
    </div>
  );
}

export function UpdatingScreen({
  phase,
  version,
  progress = null,
  onRetry,
  onBackToUnlock,
}: UpdatingScreenProps) {
  const { t } = useTranslation();
  const headingRef = useRef<HTMLSpanElement>(null);
  const failed = phase === "failed";
  const state: UpdateProgressState = progress ?? {
    phase: "starting",
    downloaded: 0,
    total: null,
  };
  const fraction = fractionOf(state);
  const percent = fraction === null ? null : Math.floor(fraction * 100);

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

        {failed ? (
          <>
            <span
              ref={headingRef}
              tabIndex={-1}
              style={HEADING_STYLE}
              className="vc-step-heading"
            >
              {t("update.failed.heading")}
            </span>
            <span style={CAPTION_STYLE}>
              {
                // The RUNNING version, never the offered one: this line is read
                // after an update that did not install, and naming the version
                // that failed as the one installed is a false statement about the
                // machine the user is looking at.
                t("update.failed.caption", { version: __APP_VERSION__ })
              }
            </span>
            <span style={HINT_STYLE}>{t("update.failed.hint")}</span>
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
          </>
        ) : (
          <>
            <div style={EYEBROW_ROW_STYLE}>
              <span style={EYEBROW_STYLE}>{t("update.updating.eyebrow")}</span>
              <VersionReveal version={version} />
            </div>

            <ProgressBar progress={state} fraction={fraction} />

            <div style={STATUS_ROW_STYLE}>
              <span
                ref={headingRef}
                tabIndex={-1}
                style={STATUS_STYLE}
                className="vc-step-heading"
                data-testid="update.status"
              >
                {t(`update.phase.${state.phase}`)}
              </span>
              <span style={PERCENT_STYLE} data-testid="update.percent">
                {percent === null ? "" : `${percent}%`}
              </span>
            </div>

            {state.phase === "downloading" && (
              // `aria-hidden`, deliberately: the bar above already carries the
              // value, and a number that changes a hundred times is not something
              // to read out.
              <span style={DETAIL_STYLE} aria-hidden="true" data-testid="update.bytes">
                {state.total === null
                  ? t("update.updating.bytes", { done: formatBytes(state.downloaded) })
                  : t("update.updating.bytesOfTotal", {
                      done: formatBytes(state.downloaded),
                      total: formatBytes(state.total),
                    })}
              </span>
            )}

            <span style={HINT_STYLE}>{t("update.updating.hint")}</span>
          </>
        )}
      </div>
    </div>
  );
}
