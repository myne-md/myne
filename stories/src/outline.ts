// The outline overlay (myne-md/myne#847 task 8).
//
// "Where are the boxes and what are the gaps" is a question a screenshot answers
// badly, so this draws the boxes. Two colours rather than one: a single colour is
// right for a component-sized story and wrong for this catalogue, which mounts
// whole screens, where one colour is a wall of lines with nothing readable in it.
//
// The container/leaf split is done in JS rather than with `:has()`, because the
// marker has to work on the WebKitGTK build CI runs and a selector the engine
// does not support fails silently, which is the one failure mode this whole
// overlay cannot afford.
//
// Nothing here reaches assistive tech: an outline is paint, not content, so there
// is no ARIA attribute to set. It is also excluded from the drift baseline by
// being applied to a marker attribute rather than to the story's own DOM.

const STYLE_ELEMENT_ID = "stories-outline";
const MARKER = "data-outline";

/**
 * Mark every element under `root` as a container or a leaf, and inject the two
 * rules. Returns how many elements were marked, so a caller can tell "the
 * overlay did nothing" from "the story has no elements".
 */
export function applyOutline(root: Element): number {
  let marked = 0;
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const element of elements) {
    const isContainer = element.children.length > 0;
    element.setAttribute(MARKER, isContainer ? "container" : "leaf");
    marked += 1;
  }

  let style = document.getElementById(STYLE_ELEMENT_ID);
  if (style === null) {
    style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    document.head.appendChild(style);
  }
  // The colours are tokens, so the overlay follows the active palette like
  // everything else. `--accent` for a container, `--danger` for a leaf: a leaf is
  // where a gap between two boxes actually shows.
  style.textContent = [
    `[${MARKER}="container"] { outline: 1px solid var(--accent) !important; outline-offset: -1px; }`,
    `[${MARKER}="leaf"] { outline: 1px solid var(--danger) !important; outline-offset: -1px; }`,
  ].join("\n");
  return marked;
}

/** Remove the marks and the rules. */
export function clearOutline(): void {
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
  for (const element of Array.from(document.querySelectorAll(`[${MARKER}]`))) {
    element.removeAttribute(MARKER);
  }
}
