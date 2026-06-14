// Global CSS for the attachment-insert UI surfaces (toast + import-&-convert
// diff-preview modal). Same posture as `editor/floating-styles.ts`: these
// elements mount to `document.body` so a `<style>` appended to `document.head`
// once on first use is how they get their tokens (CM6 theme classes are scoped
// to `.cm-editor`, which these escape).
//
// All values use `var(--*)` tokens from `docs/design/colors_and_type.css` with
// hex fallbacks, so live tokens win and fallbacks only apply if the variable
// layer fails to load.

const STYLE_ID = "myne-attachment-insert-styles";

const CSS = `
.cm-attach-toast {
  position: fixed;
  bottom: var(--space-5, 24px);
  right: var(--space-5, 24px);
  max-width: 360px;
  background-color: var(--bg-2, #f3f1eb);
  border: 1px solid var(--line-1, #e3e2dd);
  border-radius: var(--radius-2, 6px);
  box-shadow: var(--shadow-2, 0 4px 12px rgba(0,0,0,0.08));
  padding: var(--space-3, 10px) var(--space-4, 14px);
  font-family: var(--font-sans);
  font-size: 13px;
  color: var(--fg-1, #1a1a17);
  z-index: 1100;
}

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
  padding: 16px 20px 4px;
  font-size: 15px;
  font-weight: 600;
}
.cm-attach-diff-subtitle {
  padding: 0 20px 12px;
  font-size: 13px;
  color: var(--fg-3, #6b6a64);
}
.cm-attach-diff-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 20px;
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
  gap: 8px;
  padding: 12px 20px;
}
.cm-attach-diff-btn {
  border: 1px solid var(--line-2, #c8c7c1);
  background: transparent;
  color: var(--fg-1, #1a1a17);
  font-family: var(--font-sans);
  font-size: 13px;
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
  font-weight: 600;
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

/* Click-to-preview lightbox (dogfooding fix #3). Centered, size-capped image
   shown directly on a dimmed backdrop — no white frame/padding/box. Mounts to
   document.body so it escapes the CM theme scope. Esc / backdrop-click / the
   top-right × button close it (wired in lightbox.ts). */
.cm-attach-lightbox-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5, 24px);
  z-index: 1300;
  cursor: zoom-out;
}
.cm-attach-lightbox-img {
  /* The image sits directly on the dimmed backdrop — no white frame, padding,
     or background box. A focused preview, not a full-bleed takeover. */
  max-width: min(80vw, 1100px);
  max-height: 80vh;
  object-fit: contain;
  display: block;
  cursor: default;
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
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3, 10px);
  padding: var(--space-4, 14px);
  background: var(--paper, #faf8f3);
  border-radius: var(--radius-3, 8px);
  box-shadow: var(--shadow-3, 0 8px 24px rgba(0,0,0,0.12));
}
/* "Loading…" chip shown inside the (always-visible) reader surface until the
   document loads + the first page paints. */
.cm-attach-lightbox-pdf .cm-attachment-pdf-loading {
  margin: auto;
  padding: var(--space-5, 24px);
  font-family: var(--font-sans);
  font-size: 13px;
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
  font-size: 13px;
  letter-spacing: 0.06em;
  color: var(--fg-3, #6b6a64);
}

.cm-attach-lightbox-close {
  position: fixed;
  top: var(--space-4, 14px);
  right: var(--space-4, 14px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: var(--radius-2, 6px);
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.82);
  cursor: pointer;
  line-height: 0;
}
.cm-attach-lightbox-close:hover {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}
.cm-attach-lightbox-close:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.7);
  outline-offset: 2px;
}

/* Vault-wide Export (Save As) affordance pinned left of the close button. */
.cm-attach-lightbox-export {
  position: fixed;
  top: var(--space-4, 14px);
  right: calc(var(--space-4, 14px) + 40px);
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  border: none;
  border-radius: var(--radius-2, 6px);
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.82);
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.cm-attach-lightbox-export:hover {
  background: rgba(255, 255, 255, 0.18);
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
  padding: 4px;
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
  font-size: 13px;
  padding: 6px 8px;
  border-radius: var(--radius-1, 4px);
  cursor: pointer;
  white-space: nowrap;
}
.cm-attachment-file-card-menuitem:hover {
  background-color: var(--paper-2, #f3f1eb);
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
