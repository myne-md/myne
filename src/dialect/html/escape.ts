// HTML escaping for the dialect's HTML projection emitter (MYND-255).
//
// EVERYTHING that reaches the emitted document as text or attribute value
// passes through one of these two helpers — the emitter's default posture is
// escape-by-default; only vetted renderer output (KaTeX, mermaid's own
// sanitized SVG, DOMPurify output) bypasses them.

const TEXT_RE = /[&<>]/g;
const ATTR_RE = /[&<>"']/g;

const REPLACEMENTS: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a text run for element content. */
export function escapeHtml(text: string): string {
  return text.replace(TEXT_RE, (ch) => REPLACEMENTS[ch] ?? ch);
}

/** Escape a value for a double-quoted attribute position. */
export function escapeAttr(value: string): string {
  return value.replace(ATTR_RE, (ch) => REPLACEMENTS[ch] ?? ch);
}
