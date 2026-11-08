// Global CSS for the attachment-insert UI surfaces (toast + import-&-convert
// diff-preview modal). Same posture as `editor/floating-styles.ts`: these
// elements mount to `document.body` so a `<style>` appended to `document.head`
// once on first use is how they get their tokens (CM6 theme classes are scoped
// to `.cm-editor`, which these escape).
//
// All values use `var(--*)` tokens from `agent-tooling/docs/design/colors_and_type.css` with
// hex fallbacks, so live tokens win and fallbacks only apply if the variable
// layer fails to load.

const STYLE_ID = "myne-attachment-insert-styles";

// NOTE: the attachment toast's styling moved to the shared `.myne-toast` rules
// in the app's `tokens.css` (#238), so the toast looks identical to the React
// `<Toast>`. `showAttachmentToast` still tags the node with the legacy
// `cm-attach-toast` class as a test/hook alias, but it carries no styles here.
const CSS = `
.cm-attach-diff-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
}
.cm-attach-diff {
  width: 560px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 96px);
  display: flex;
  flex-direction: column;
  background-color: var(--paper, #faf8f3);
  border: 1px solid var(--line-2, #c8c7c1);
  border-radius: var(--radius-3, 8px);
  box-shadow: var(--shadow-3, 0 8px 24px rgba(0,0,0,0.12));
  font-family: var(--font-sans);
  color: var(--fg-1, #1a1a17);
}
.cm-attach-diff-title {
  padding: var(--space-4) 20px 4px;
  font-size: 15px;
  font-weight: var(--weight-semibold);
}
.cm-attach-diff-subtitle {
  padding: 0 20px 12px;
  font-size: var(--text-sm);
  color: var(--fg-3, #6b6a64);
}
.cm-attach-diff-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-1) 20px;
  border-top: 1px solid var(--line-1, #e3e2dd);
  border-bottom: 1px solid var(--line-1, #e3e2dd);
}
.cm-attach-diff-row {
  padding: 10px 0;
  border-bottom: 1px solid var(--line-1, #e3e2dd);
}
.cm-attach-diff-row:last-child {
  border-bottom: none;
}
.cm-attach-diff-line {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.cm-attach-diff-before {
  color: var(--fg-3, #6b6a64);
  text-decoration: line-through;
}
.cm-attach-diff-after {
  color: var(--fg-1, #1a1a17);
}
.cm-attach-diff-skipped {
  font-style: italic;
  color: var(--fg-3, #6b6a64);
  font-family: var(--font-sans);
  font-size: 12px;
}
.cm-attach-diff-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) 20px;
}
.cm-attach-diff-btn {
  border: 1px solid var(--line-2, #c8c7c1);
  background: transparent;
  color: var(--fg-1, #1a1a17);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  padding: 7px 14px;
  border-radius: var(--radius-1, 4px);
  cursor: pointer;
}
.cm-attach-diff-btn:hover {
  background-color: var(--paper-2, #f3f1eb);
}
.cm-attach-diff-btn-primary {
  border-color: var(--accent, #2c4a7a);
  background-color: var(--accent, #2c4a7a);
  color: var(--accent-on, #fff);
  font-weight: var(--weight-semibold);
}
.cm-attach-diff-btn-primary:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Indeterminate progress-chip animation (dogfooding fix #4). Defined here
   (document-global) so the editor-scoped .cm-attachment-progress-bar::after
   keyframe resolves; @keyframes can't live inside EditorView.theme. A sweeping
   accent segment — no spinner glyph. */
@keyframes cm-attachment-progress-indeterminate {
  0%   { transform: translateX(-100%); }
  50%  { transform: translateX(80%); }
  100% { transform: translateX(260%); }
}
@media (prefers-reduced-motion: reduce) {
  .cm-attachment-progress-bar::after { animation-duration: 2.4s; }
}

/* Live-collaboration awareness caret (live-collab, collab-presence-ui): a peer's
   caret fades in ONCE when it joins and is otherwise static, a one-shot fade, never
   a loop or a blink. The @keyframes lives here (the CM theme's StyleModule can't
   emit it, exactly as the progress chip above); reduced motion removes the fade
   rather than slowing a looping one, since there is no loop to slow. */
@keyframes myne-awareness-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.cm-awareness-caret {
  animation: myne-awareness-fade-in var(--duration-base) var(--ease-standard);
}
@media (prefers-reduced-motion: reduce) {
  .cm-awareness-caret { animation: none; }
}

/* Click-to-preview lightbox (dogfooding fix #3). Centered, size-capped image
   shown directly on an OPAQUE backdrop — no white frame/padding/box. Mounts to
   document.body so it escapes the CM theme scope. Esc / backdrop-click / the
   top-right × button close it (wired in lightbox.ts). */
.cm-attach-lightbox-backdrop {
  position: fixed;
  inset: 0;
  /* Fully opaque, not a 72% scrim. A scrim leaves the app legible underneath,
     so a screenshot — which is most of what gets previewed — was read against
     a tab strip and a sidebar showing through it, and the eye kept resolving
     the wrong layer. A preview is a surface you look AT, and the thing behind
     it is not context, it is noise. */
  /* A literal, and NOT var(--scrim): that token is the translucent modal
     scrim by definition, and it is theme-tinted (rgba(11, 11, 9, .4) in the
     light theme). A picture mat must not tint the picture — a warm-grey wash
     over a screenshot shifts every colour in it — and it must be the same
     black in every theme, so this is one of the few values that is correctly
     not a token. Recorded in scripts/token-adoption.json for that reason. */
  background: var(--mat-black);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5, 24px);
  z-index: 1300;
  cursor: zoom-out;
  overflow: hidden;
}
/* The image's frame, and the reason the padding above was never doing anything.

   The image is position: absolute, so its containing block is the backdrop's
   PADDING box — and mountZoom fits it to stage.clientWidth/clientHeight,
   which INCLUDES padding. Both measurements therefore ignored the gutter, and
   a landscape screenshot fitted edge to edge: under the × and Export buttons
   at the top (top: max(56px, …), 32px tall) and under the zoom bar at the
   bottom. The chrome sat on the picture instead of around it.

   So the stage is its own element and the gutter is its INSET rather than
   anyone's padding: clientHeight then measures the box we actually want the
   image inside, and the fit falls out of it. The top and bottom are unequal on
   purpose — they clear different chrome. */
.cm-attach-lightbox-stage {
  position: absolute;
  /* Clears the × / Export row (top: 56px + 32px tall) with room to breathe. */
  top: 96px;
  /* Clears the zoom bar (bottom: 20px, ~42px tall). */
  bottom: 72px;
  left: 0;
  right: 0;
  /* The max width. margin-inline: auto centres an absolutely positioned box
     whose left and right are both 0 and whose width is definite. */
  width: min(calc(100% - 2 * var(--space-5, 24px)), 1600px);
  margin-inline: auto;
  /* The image is transform-driven; clip a zoomed one to the frame rather than
     to the viewport, so it stays inside the picture area (MYND-594). */
  overflow: hidden;
}
.cm-attach-lightbox-img {
  /* The image sits directly on the backdrop — no white frame, padding, or
     background box. Absolutely positioned + transform-driven so it can be
     zoomed/panned (MYND-594); the controller sets translate/scale + cursor. */
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  will-change: transform;
  /* We own wheel/pinch/pan — keep the browser off the gesture + native drag. */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  /* cursor is set by the zoom controller: zoom-in (fit) / grab / grabbing. */
}
/* Zoom controls (ED-08: − / percentage / +), floating bottom-centre over the
   dimmed backdrop. The percentage doubles as a reset-to-fit button. */
.cm-attach-lightbox-zoom {
  position: fixed;
  bottom: max(20px, calc(env(safe-area-inset-bottom, 0px) + 16px));
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: var(--space-1);
  border-radius: var(--radius-pill);
  background: rgba(20, 20, 20, 0.72);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  z-index: 1310;
  font-family: var(--font-sans);
}
.cm-attach-lightbox-zoom-btn,
.cm-attach-lightbox-zoom-pct {
  border: none;
  background: transparent;
  color: #fff;
  cursor: pointer;
  font-family: inherit;
  height: 34px;
  border-radius: var(--radius-pill);
  display: flex;
  align-items: center;
  justify-content: center;
}
.cm-attach-lightbox-zoom-btn {
  width: 34px;
  font-size: 20px;
  line-height: 1;
}
.cm-attach-lightbox-zoom-pct {
  min-width: 56px;
  padding: 0 8px;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}
.cm-attach-lightbox-zoom-btn:hover,
.cm-attach-lightbox-zoom-pct:hover {
  background: rgba(255, 255, 255, 0.14);
}
.cm-attach-lightbox-zoom-btn:focus-visible,
.cm-attach-lightbox-zoom-pct:focus-visible {
  outline: 2px solid var(--accent, #6ea8fe);
  outline-offset: 2px;
}
/* Lightbox PDF mode: a bigger scrollable multi-page reader mounted in place of
   the <img>. The surface itself scrolls (it is the IntersectionObserver root);
   pages stack vertically inside. Sits centered on the dimmed backdrop. */
.cm-attach-lightbox-backdrop-pdf {
  /* Pages scroll inside the surface, so the backdrop is not a zoom-out cursor. */
  cursor: default;
}
.cm-attach-lightbox-pdf {
  width: min(80vw, 1100px);
  max-width: min(80vw, 1100px);
  height: 80vh;
  max-height: 80vh;
  /* Both axes scroll: a user-scaled page (MYND-594) can exceed the surface
     width. "safe center" keeps pages centred until they overflow, then aligns
     to the start so horizontal scroll reveals the whole page (plain center
     would strand the left overflow unreachable). */
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: safe center;
  gap: var(--space-3, 10px);
  padding: var(--space-4, 14px);
  background: var(--paper, #faf8f3);
  border-radius: var(--radius-3, 8px);
  box-shadow: var(--shadow-3, 0 8px 24px rgba(0,0,0,0.12));
}
/* Phone / compact: the 80vw surface is too narrow to read a PDF page — use
   almost the full width + height with a tight gutter so pages render at a
   legible size (paired with the surface-fit pageWidth in lightbox.ts). MYND-477. */
@media (max-width: 700px) {
  .cm-attach-lightbox-pdf {
    width: 96vw;
    max-width: 96vw;
    height: 88vh;
    max-height: 88vh;
    padding: var(--space-2);
  }
}
/* "Loading…" chip shown inside the (always-visible) reader surface until the
   document loads + the first page paints. */
.cm-attach-lightbox-pdf .cm-attachment-pdf-loading {
  margin: auto;
  padding: var(--space-5, 24px);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  color: var(--fg-3, #6b6a64);
  letter-spacing: 0.01em;
}
/* An UNRENDERED page reads as a muted "pending page" outline (dashed frame on
   the paper surface), NOT a solid white block — so a not-yet-painted page reads
   as pending, not broken. */
.cm-attach-lightbox-pdf .cm-attachment-pdf-page {
  display: block;
  /* The reader surface is a flex column; without this each page (a flex item)
     shrinks to ~0 height regardless of its explicit height — the pages
     collapsed into thin white stripes. Pin the intrinsic size. */
  flex-shrink: 0;
  background: rgba(0, 0, 0, 0.02);
  border: 1px dashed var(--line-2, #c8c7c1);
  border-radius: var(--radius-1, 4px);
  overflow: hidden;
}
/* Once the real canvas swaps in, drop the pending outline and seat the page on
   the neutral paper tone with the page shadow. */
.cm-attach-lightbox-pdf .cm-attachment-pdf-page-rendered {
  background: var(--paper-2, #f3f1eb);
  border: 1px solid transparent;
  box-shadow: var(--shadow-1, 0 1px 3px rgba(0,0,0,0.08));
}
.cm-attach-lightbox-pdf .cm-attachment-pdf-page-canvas {
  display: block;
  max-width: 100%;
}
.cm-attach-lightbox-pdf-fallback {
  margin: auto;
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  letter-spacing: 0.06em;
  color: var(--fg-3, #6b6a64);
}

.cm-attach-lightbox-close {
  position: fixed;
  top: max(56px, calc(env(safe-area-inset-top, 0px) + 10px));
  right: var(--space-4, 14px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: var(--radius-2, 6px);
  /* A solid dark scrim + border so the button stays legible over BOTH the dark
     image backdrop AND the light PDF paper surface (the old 10% white fill was
     nearly invisible at rest — MYND-477 / attachment-window polish). */
  background: rgba(18, 18, 20, 0.66);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  line-height: 0;
}
.cm-attach-lightbox-close:hover {
  background: rgba(40, 40, 44, 0.82);
  border-color: rgba(255, 255, 255, 0.45);
  color: #fff;
}
.cm-attach-lightbox-close:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.7);
  outline-offset: 2px;
}

/* Vault-wide Export (Save As) affordance pinned left of the close button. */
.cm-attach-lightbox-export {
  position: fixed;
  top: max(56px, calc(env(safe-area-inset-top, 0px) + 10px));
  right: calc(var(--space-4, 14px) + 40px);
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: var(--radius-2, 6px);
  background: rgba(18, 18, 20, 0.66);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  cursor: pointer;
}
.cm-attach-lightbox-export:hover {
  background: rgba(40, 40, 44, 0.82);
  border-color: rgba(255, 255, 255, 0.45);
  color: #fff;
}
.cm-attach-lightbox-export:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.7);
  outline-offset: 2px;
}

/* Generic file-card overflow menu (MYND-173). Body-mounted (portaled out of
   the editor so .cm-scroller can't clip it) + positioned with fixed coords in
   JS, so it lives here in the global stylesheet rather than the .cm-editor
   theme. */
.cm-attachment-file-card-menu {
  display: flex;
  flex-direction: column;
  min-width: 150px;
  padding: var(--space-1);
  background-color: var(--paper, #faf8f3);
  border: 1px solid var(--line-2, #c8c7c1);
  border-radius: var(--radius-2, 6px);
  box-shadow: var(--shadow-2, 0 4px 12px rgba(0, 0, 0, 0.08));
}
.cm-attachment-file-card-menuitem {
  appearance: none;
  border: none;
  background: transparent;
  text-align: left;
  color: var(--fg-1, #1a1a17);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  padding: 6px 8px;
  border-radius: var(--radius-1, 4px);
  cursor: pointer;
  white-space: nowrap;
}
.cm-attachment-file-card-menuitem:hover {
  background-color: var(--paper-2, #f3f1eb);
}
/* Disabled-not-hidden row (MYND-552 Transcribe when AI is off / folder excluded):
   the real label is kept but muted and non-activating. */
.cm-attachment-file-card-menuitem-disabled,
.cm-attachment-file-card-menuitem:disabled {
  color: var(--fg-3, #6b6a64);
  cursor: default;
  opacity: 0.6;
}
.cm-attachment-file-card-menuitem-disabled:hover {
  background-color: transparent;
}
/* Group rule between the file actions, the sizes, the alignments and the alt
   editor (myne#409). Presentational only: no name, no role, no tab stop. */
.cm-attachment-file-card-menusep {
  height: 1px;
  margin: var(--space-1, 4px) 0;
  background-color: var(--line-1, #e3e2dd);
}
/* The active choice in a size / alignment group. The tick is a ::before rather
   than DOM text so the row's accessible name stays the label alone and is not
   read as "check mark Small"; aria-checked on the menuitemradio is what
   announces the state. */
.cm-attachment-file-card-menuitem-checked {
  font-weight: var(--weight-medium, 500);
}
.cm-attachment-file-card-menuitem-checked::before {
  /* The Lucide check glyph as a mask, not the U+2713 character. The design
     canon (agent-tooling/docs/design/README.md, Iconography) bans unicode symbols as icons
     and names this exact replacement, with keyboard-shortcut glyphs its only
     exception. This same feature quotes that rule one file over to justify
     drawing its alert marker from Lucide, so a unicode tick here contradicted
     the change that introduced it.
     A mask rather than an inline SVG element because the tick is decorative,
     which is what the comment above this rule is about: it must stay out of
     the accessible name, and a ::before carrying a mask has no DOM node to
     announce. The path is the same 20-6-9-17-4-12 polyline ICON_PATHS.check
     holds. */
  content: "";
  display: inline-block;
  width: 1em;
  height: 1em;
  vertical-align: -0.15em;
  margin-right: var(--space-1, 4px);
  background-color: var(--fg-2, #4a4944);
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E") center / 0.85em 0.85em no-repeat;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E") center / 0.85em 0.85em no-repeat;
}
/* Keep unchecked rows in the same groups aligned with the checked one, so the
   list does not jump horizontally as the choice moves. */
.cm-attachment-file-card-menuitem[role="menuitemradio"]:not(
    .cm-attachment-file-card-menuitem-checked
  )::before {
  content: "";
  display: inline-block;
  width: 1em;
  margin-right: var(--space-1, 4px);
}

/* Voice-note recording bar (MYND-259). Body-mounted floating surface (escapes
   the .cm-editor theme scope, like the toast/menu above). */
.cm-voice-rec {
  position: fixed;
  bottom: 44px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 14px;
  background-color: var(--paper, #faf8f3);
  border: 1px solid var(--line-2, #c8c7c1);
  border-radius: var(--radius-3, 8px);
  box-shadow: var(--shadow-3, 0 8px 24px rgba(0, 0, 0, 0.12));
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  color: var(--fg-1, #1a1a17);
  z-index: 1250;
}
/* A STATIC red dot. It used to pulse (cm-voice-rec-pulse, 1.2s ease-in-out
   infinite), which PRODUCT.md principle 4 forbids in both motion tiers and
   which scripts/check-motion-canon.mjs now fails on
   (agent-tooling/design-notes/ui/0632).

   Removing it costs nothing, and that is the point: the recording bar already
   carries .cm-voice-rec-time, a monospace elapsed timer ticking once a
   second. That timer is the liveness signal, it is INFORMATION rather than
   decoration, and it is the "state is communicated by typography" clause
   working exactly as written. The dot says "recording"; the number says "and
   still going". A second, wordless restatement of the first in fading opacity
   was never adding a third thing. */
.cm-voice-rec-dot {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-pill);
  background-color: var(--danger, #b3261e);
}
.cm-voice-rec-time {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg-2, #44423d);
  min-width: 34px;
}
.cm-voice-rec-meter {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 18px;
}
/* Each bar's level is set live in JS (a rolling waveform of recent input), so
   the meter reads as voice waves rather than a left-to-right fill.

   It is driven by transform: scaleY() rather than by height
   (myne-md/myne#773). The two are geometrically IDENTICAL here — the meter is
   align-items: center, so a full-height box scaled from its centre occupies
   exactly the band a centred short box did — but they cost very differently:
   setLevel runs at audio rate over every bar in the meter, and a height
   change lays out and paints the whole row on each one, where a transform is
   composited. This is the single hottest animation in the editor and it was the
   only one animating a layout property. */
.cm-voice-rec-bar {
  width: 3px;
  height: 100%;
  transform-origin: center;
  transform: scaleY(0.12);
  border-radius: var(--radius-pill);
  background-color: var(--accent, #2c4a7a);
  transition: transform var(--duration-fast) var(--ease-out);
}
.cm-voice-rec-warning {
  font-size: 12px;
  color: var(--warning, #8a6d1f);
}
.cm-voice-rec-stop,
.cm-voice-rec-cancel {
  appearance: none;
  border: 1px solid var(--line-2, #c8c7c1);
  background: transparent;
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  padding: 5px 12px;
  border-radius: var(--radius-1, 4px);
  cursor: pointer;
  color: var(--fg-1, #1a1a17);
}
.cm-voice-rec-stop {
  border-color: var(--danger, #b3261e);
  background-color: var(--danger, #b3261e);
  color: #fff;
  font-weight: var(--weight-semibold);
}
.cm-voice-rec-stop:disabled,
.cm-voice-rec-cancel:disabled {
  opacity: 0.55;
  cursor: default;
}
.cm-voice-rec-cancel:hover {
  background-color: var(--paper-2, #f3f1eb);
}

/* Meeting-session bar (myne-md/myne#789). The box, meter, dot, timer and
   buttons are the voice bar's own classes above, deliberately: the two are the
   same floating surface with different contents, and a second copy of the same
   dozen values is a second place for them to drift. Only the elements the voice
   bar does not have are declared here. */
.cm-meeting-rec {
  flex-direction: column;
  align-items: stretch;
  max-width: min(520px, 80vw);
}
.cm-meeting-rec-warnings {
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 4px);
}
/* A standing platform notice, not a warning: it is true before the session
   starts, so it must not read as something that just went wrong. */
.cm-meeting-rec-notice {
  font-size: 12px;
  color: var(--fg-2, #44423d);
}
.cm-meeting-rec-transcript {
  max-height: 120px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 4px);
}
.cm-meeting-rec-block {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--fg-2, #44423d);
}

/* Transcription busy meter (voice-to-text MYND-552). The @keyframes lives here
   in the global sheet (the CM theme's StyleModule doesn't emit @keyframes); the
   bar's static box + colour come from the scoped theme. */
/* This one STAYS looping, and the distinction from the dot above is the whole
   of agent-tooling/design-notes/ui/0632: a transcription busy meter reports that work is
   in flight, which is information the user asked for, so it is an indeterminate
   progress indicator rather than decoration.

   Two things about it did change. It animated height, which lays out and
   paints on every frame; transform: scaleY() is the compositor-only
   equivalent and transform-origin: bottom keeps it growing from the baseline
   the way the height version did. And its reduced-motion arm stopped it dead,
   which is the failure MYND-630 records for the spinner — a frozen progress
   indicator reads as hung, not as calm, at the one moment the user most needs
   to know the app is alive. It now takes the same data-motion="essential"
   opt-in, which the global rule in each client's shell sheet slows to half
   speed rather than freezing. */
@keyframes cm-attachment-transcript-pulse {
  0%, 100% { transform: scaleY(0.3); opacity: 0.4; }
  50% { transform: scaleY(1); opacity: 1; }
}
.cm-attachment-audio-transcript-bar {
  transform-origin: bottom;
  animation: cm-attachment-transcript-pulse 1s ease-in-out infinite;
  /* The per-bar stagger, from the canon rather than from a number typed into the
     caller. The two stagger tokens 0632 added are exactly this shape, and the
     caller only declares the index: the delay is computed here so the loop keeps
     getComputedStyle() out of it, and the cap is the token's rather than a second
     number. */
  animation-delay: min(
    calc(var(--stagger-index, 0) * var(--stagger-step)),
    var(--stagger-max)
  );
}
`;

export function ensureAttachmentInsertStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const styleEl = document.createElement("style");
  styleEl.id = STYLE_ID;
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
}

/** Shared test seam for the vanilla-DOM attachment surfaces (toast, lightbox,
 *  diff-preview): true only when a usable `document` body exists, so they no-op
 *  cleanly under node/jsdom-less test envs instead of throwing. */
export function hasDom(): boolean {
  return typeof document !== "undefined" && document.body !== null;
}
