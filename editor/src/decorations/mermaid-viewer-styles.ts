// Global stylesheet for the mermaid viewer chrome (myne-md/myne#708).
//
// WHY THIS IS NOT IN `theme.ts`. That module's rules are handed to
// `EditorView.theme(...)`, which CodeMirror scopes under a generated class on
// the editor element. The expanded viewer is appended to `document.body` (it has
// to be: it covers the editor rather than living inside it), so NOTHING in the
// theme sheet reaches it, and an unstyled overlay rendered as a static block at
// the bottom of the page. The attachment lightbox solved the same problem the
// same way. The pan/zoom cluster and the top-right chrome are used in BOTH
// scopes, so they live here rather than in two places that could drift.
//
// Values are tokens throughout: a numeric literal here would be unreachable to a
// custom theme, which is what `scripts/check-token-adoption.mjs` ratchets.

const CSS = `
.cm-mermaid-svg {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  display: block;
}
.cm-mermaid-controls {
  position: absolute;
  bottom: var(--space-2);
  right: var(--space-2);
  display: grid;
  grid-template-columns: repeat(3, auto);
  grid-template-areas: ". up zin" "lft rst rgt" ". dwn zot";
  gap: var(--space-1);
}
.cm-mermaid-control {
  appearance: none;
  color: var(--ink-1);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  padding: var(--space-2);
  cursor: pointer;
  background: var(--paper-2);
  border: 1px solid var(--line-1);
  border-radius: var(--radius-2, 6px);
}
.cm-mermaid-control:hover { background: var(--paper-3); }
.cm-mermaid-control:focus-visible {
  outline: var(--focus-ring-width, 2px) solid var(--accent-1, currentColor);
  outline-offset: -2px;
}
.cm-mermaid-control-up { grid-area: up; }
.cm-mermaid-control-zin { grid-area: zin; }
.cm-mermaid-control-lft { grid-area: lft; }
.cm-mermaid-control-rst { grid-area: rst; }
.cm-mermaid-control-rgt { grid-area: rgt; }
.cm-mermaid-control-dwn { grid-area: dwn; }
.cm-mermaid-control-zot { grid-area: zot; }
.cm-mermaid-chrome-bar {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: flex;
  gap: var(--space-1);
}
.cm-mermaid-chrome {
  appearance: none;
  color: var(--ink-1);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font: inherit;
  line-height: 1;
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  background: var(--paper-2);
  border: 1px solid var(--line-1);
  border-radius: var(--radius-2, 6px);
}
.cm-mermaid-chrome:hover { background: var(--paper-3); }
.cm-mermaid-chrome:focus-visible {
  outline: var(--focus-ring-width, 2px) solid var(--accent-1, currentColor);
  outline-offset: -2px;
}
.cm-mermaid-expand {
  position: fixed;
  z-index: 50;
  overflow: hidden;
  background: var(--paper);
  border: 1px solid var(--line-1);
  outline: none;
}
.cm-mermaid-expand-stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  outline: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.cm-mermaid-debug {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  z-index: 60;
  color: var(--danger);
  font-family: var(--font-mono);
  font-size: var(--text-xs, 0.8em);
  white-space: pre;
  pointer-events: none;
}
`;

let injected = false;

/** Inject the viewer chrome stylesheet once per document. */
export function ensureMermaidViewerStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.setAttribute("data-myne-mermaid-viewer", "");
  style.textContent = CSS;
  document.head.appendChild(style);
}
