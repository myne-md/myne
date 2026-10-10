// Forcing a pseudo-state on the rendered story (myne-md/myne#845).
//
// A static mount cannot reach `:hover`, `:focus-visible` or `:active`, which is
// why an entire class of defect had no review path: the first finding of the
// myne-md/myne#843 review was exactly this. There is no CSS mechanism to force a
// pseudo-class from an attribute, so this MIRRORS the rules instead: it reads the
// loaded stylesheets, finds the rules whose selector carries the pseudo-class,
// strips the pseudo-class from the selector and re-emits the declarations scoped
// to a marker attribute on the story frame.
//
// The result is "every element that would match this state, showing it at once".
// It is a deliberate approximation and the UI says so, because a screenshot of a
// forced state must never be read as a real one.

const MARKER_ATTRIBUTE = "data-force-state";
const STYLE_ELEMENT_ID = "stories-forced-state";

/** The story frame the forced state applies to. */
function storyRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="stories.story"]');
}

/** Strip pseudo-classes and pseudo-elements to get the base selector. */
function baseSelector(selector: string): string[] {
  return selector
    .split(",")
    .map((part) => part.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, "").trim())
    .filter((part) => part.length > 0);
}

/** Mirror one pseudo-class's rules onto the marker attribute. */
function mirror(state: string): string {
  const pseudo = `:${state}`;
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // A cross-origin sheet cannot be read; the app's own sheets are bundled and
      // same-origin, so this skips only a font or an embedded third party.
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      if (!rule.selectorText.includes(pseudo)) continue;
      const bases = baseSelector(rule.selectorText);
      if (bases.length === 0) continue;
      const scoped = bases
        .map((base) => `[${MARKER_ATTRIBUTE}="${state}"] ${base}`)
        .join(", ");
      parts.push(`${scoped} { ${rule.style.cssText} }`);
    }
  }
  return parts.join("\n");
}

/** Apply a forced pseudo-state to the current story. */
export function forceState(state: string): void {
  clearForcedState();
  const root = storyRoot();
  if (root === null) return;
  root.setAttribute(MARKER_ATTRIBUTE, state);
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = mirror(state);
  document.head.appendChild(style);
}

/** Remove the forced state and everything it mirrored. */
export function clearForcedState(): void {
  const root = storyRoot();
  if (root !== null) root.removeAttribute(MARKER_ATTRIBUTE);
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
}
