// Shared full-screen blocking progress surface — spinner + heading +
// optional caption + optional escape-hint footer. Used by:
//   - vault-creation `EncryptingStep` (Argon2id × 2 during `begin`)
//   - vault-recover `DecryptingStep` (Argon2id × 1 during A8d)
//
// **No cancel affordance.** Once mounted, the operation runs to
// completion; window-close is the only escape valve. Argon2id is not
// abortable mid-iteration (vault-creation / `recovery-flow.md` §3.3).
//
// **No Lock affordance** during this surface — `recovery-flow.md`'s
// recover screen uses this component for its `decrypting` sub-step,
// and `vault_unlock/commands.rs` documents the TOCTOU window: a
// vault_lock arriving mid-Argon2id finds the slot still Empty and
// the in-flight op populates afterward, silently swallowing the
// lock intent. UI-side mitigation is to suppress Lock affordances
// while this surface is mounted; the recover screen achieves this
// structurally by not rendering any Lock CTA inside its sub-steps.
//
// Reduced motion: <Spinner> keeps turning, at half speed (MYND-630). This
// surface BLOCKS the user on an Argon2id-bound operation, so a frozen ring
// here is the worst possible reading — it is exactly when "is this still
// working?" needs an answer. See the essential-motion exemption in tokens.css.

import { useEffect, useRef, type CSSProperties } from "react";
import { Spinner } from "./Spinner";
import { stageRootStyle } from "./primitives/stageRoot";

interface BlockingProgressStepProps {
  /** Optional small uppercase eyebrow above the heading. Examples:
   *  "ENCRYPTING", "RECOVERY · DECRYPTING". Penpot canon (`screen
   *  ------encrypting`, `screen------recover--decrypting`) renders
   *  one; consumers may omit when the surface doesn't need step
   *  context. */
  eyebrow?: string;
  /** Heading text shown above the spinner. e.g., "Encrypting your
   *  vault", "Decrypting your vault". */
  heading: string;
  /** Optional small line between heading and body — Penpot canon
   *  uses this for technical context (e.g., "Working… Argon2id
   *  m=256 MiB, t=3, p=2") so the user understands why the
   *  operation is slow. Distinct from `caption` (body); the
   *  sub-caption renders smaller and immediately under the
   *  heading. */
  subCaption?: string;
  /** Optional one-line body caption between sub-caption and
   *  footer. e.g., "This takes a moment." */
  caption?: string;
  /** Optional small footer hint with the escape path. e.g., "If
   *  this takes longer than 30 seconds, close the window and try
   *  again." */
  footerHint?: string;
  /** Stable E2E selector rendered as `data-testid` on the root (SYNC-8). */
  testId?: string;
}

const ROOT_STYLE: CSSProperties = {
  ...stageRootStyle,
  background: "var(--bg-1)",
  padding: "var(--space-5)",
};

const COLUMN_STYLE: CSSProperties = {
  width: 420,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 20,
};

const EYEBROW_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
  textAlign: "center",
  marginTop: "var(--space-3)",
};

const HEADING_STYLE: CSSProperties = {
  fontSize: "var(--text-2xl)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "-0.015em",
  lineHeight: 1.2,
  color: "var(--fg-display)",
  textAlign: "center",
  marginTop: "var(--space-1)",
};

const SUB_CAPTION_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  color: "var(--fg-3)",
  textAlign: "center",
  fontFamily: "var(--font-mono)",
};

const CAPTION_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  lineHeight: 1.6,
  color: "var(--fg-2)",
  textAlign: "center",
};

const FOOTER_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--fg-3)",
  textAlign: "center",
  marginTop: "var(--space-6)",
  maxWidth: 320,
};

export function BlockingProgressStep({
  eyebrow,
  heading,
  subCaption,
  caption,
  footerHint,
  testId,
}: BlockingProgressStepProps) {
  // Auto-focus the heading on mount so screen readers announce the
  // new transient surface (parity with vault-creation's `StepHeading`
  // pattern). `tabIndex={-1}` makes it focusable programmatically
  // without entering the Tab order; the `.vc-step-heading` class in
  // tokens.css suppresses the focus ring on programmatic-only focus.
  const headingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      import.meta.env.DEV &&
      new URLSearchParams(location.search).get("test-no-autofocus") === "true"
    ) {
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div style={ROOT_STYLE} data-testid={testId}>
      <div style={COLUMN_STYLE}>
        <Spinner size={36} />
        {eyebrow && <div style={EYEBROW_STYLE}>{eyebrow}</div>}
        <div
          ref={headingRef}
          tabIndex={-1}
          className="vc-step-heading"
          style={HEADING_STYLE}
        >
          {heading}
        </div>
        {subCaption && <div style={SUB_CAPTION_STYLE}>{subCaption}</div>}
        {caption && <div style={CAPTION_STYLE}>{caption}</div>}
        {footerHint && <div style={FOOTER_STYLE}>{footerHint}</div>}
      </div>
    </div>
  );
}
