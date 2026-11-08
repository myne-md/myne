// The two label treatments a form or a settings panel needs: a small uppercase
// caption over a control (`FieldLabel`) and a small uppercase heading over a group
// of controls (`SectionLabel`). Both are the canon's `.t-eyebrow` type ramp
// (`docs/design/colors_and_type.css`) — 11px, semibold, caps tracking, `fg-3` — and
// this file is the ONE place either is defined (myne-md/myne#995).
//
// # Why it is here rather than in either client
//
// `FieldLabel` was defined eleven times under `mobile/src` and `SectionLabel` eight:
// the same `<div>`, the same four type values, written out per screen. Every copy
// differed in the one thing a copy-paste changes first — prop order, a margin, the
// colour token it picked — so no text comparison groups them and nothing measured
// them. `mobile/src` cannot import from `src/` by default (a build-time alias per
// shared module is what crosses that line), which is the honest reason the copies
// existed: the shared owner had nowhere to live. This file is that owner, and
// `mobile/tsconfig.json`, `mobile/vite.config.ts` and `mobile/vitest.config.ts` each
// carry the `@myne/field-label` alias to it.
//
// # The type values are the CANON's, not the copies'
//
// Every mobile copy said `fontSize: 12` and `letterSpacing: "0.06em"`. The canon's
// `.t-eyebrow` says `--text-xs` (11px) and `--tracking-caps` (0.08em), and the two
// disagreeing is the drift AGENTS.md says to settle on the merits: the canon is
// explicit and the copies were written from memory, so the labels move to the token
// ramp. That is a visible one-pixel change on nineteen surfaces and it is stated
// here rather than discovered in a screenshot diff.
//
// `--line-3` was used as the SECTION heading's colour in five of the six copies.
// That token is the disabled-CONTROL grey (`#a3a29c`, documented as such in
// `client-core/src/tokens.css`); the canon's eyebrow uses `--fg-3`, the tertiary
// text tone. A border token painted as text is the same class of drift one level
// down, so both labels read `--fg-3` here, with `tone="danger"` for the one section
// that destroys something.
//
// # Layout stays the caller's, because it is not type
//
// The copies also differed in margins and in whether the heading carried the card's
// own inset (`padding: 0 4px 8px`). Those are layout against a specific card, not a
// property of "a label", so they are props: `mt`, `padded` and `style`. Deliberately
// NOT re-designed in the change that removed the copies — a refactor that also
// re-spaces nineteen surfaces is a refactor nobody can review.

import type { CSSProperties, ReactNode } from "react";

const EYEBROW: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  lineHeight: "var(--leading-normal)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const SECTION_INSET = "0 var(--space-1) var(--space-2)";

/**
 * A caption over one control. A `<div>` rather than a `<label>`, deliberately and
 * with the consequence stated: nothing here associates the caption with its input,
 * so a caller that needs that association passes `id` and points the input's
 * `aria-labelledby` at it (or uses a real `<label>`, which is the better answer
 * wherever the input can take one).
 */
export function FieldLabel({
  children,
  id,
  mt,
  style,
}: {
  children: ReactNode;
  id?: string;
  /** Top margin in px, for a caption that does not sit under the previous field. */
  mt?: number;
  /** Caller overrides, applied last so a surface can adjust one label without a fork. */
  style?: CSSProperties;
}) {
  return (
    <div id={id} style={{ ...EYEBROW, marginTop: mt, marginBottom: "var(--space-2)", ...style }}>
      {children}
    </div>
  );
}

/**
 * A heading over a group of related controls, with the card inset that four of the
 * six former copies drew. `padded={false}` is for a heading that already sits inside
 * a padded card (`mobile/src/screens/organize`, `mobile/src/screens/system`).
 */
export function SectionLabel({
  children,
  id,
  tone = "muted",
  mt = 18,
  padded = true,
  style,
}: {
  children: ReactNode;
  id?: string;
  /** `danger` for the section that destroys a vault; the type ramp is identical. */
  tone?: "muted" | "danger";
  /** Top margin in px. 18 is what five of the six former copies defaulted to. */
  mt?: number;
  /** Draw the card's horizontal inset (`0 4px 8px`). Off inside an already-padded card. */
  padded?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      id={id}
      style={{
        ...EYEBROW,
        color: tone === "danger" ? "var(--danger)" : "var(--fg-3)",
        marginTop: mt,
        ...(padded ? { padding: SECTION_INSET } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}
