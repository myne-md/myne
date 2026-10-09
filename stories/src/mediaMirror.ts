// Forcing a media query on the rendered story (myne-md/myne#847).
//
// Two of the axes a reviewer needs are media queries, not attributes: reduced
// motion and forced colors. There is no CSS mechanism to force either from an
// attribute, and no way to make `matchMedia` lie for a stylesheet, so this
// MIRRORS the rules instead: it reads the loaded stylesheets, finds the
// `@media` blocks whose condition matches, and re-emits their inner rules scoped
// to a marker attribute on the stage.
//
// The approach is the one `interactions.ts` already uses for pseudo-classes, and
// the reasoning is the same: a static mount cannot reach the state, so the
// alternative is an entire class of defect with no review path.
//
// It is a deliberate approximation and the UI says so. A screenshot of a forced
// axis must never be read as a real one, because a real one also depends on the
// OS setting, the engine's own forced-colors palette, and the reader's actual
// preference.
//
// `!important` is PRESERVED rather than stripped: the reduced-motion block
// depends on it to outrank a component's own transition, and dropping it would
// make the forced view weaker than the real one in exactly the case it exists to
// show.

const STYLE_ELEMENT_ID = "stories-forced-media";

/**
 * Re-emit every rule inside `@media <condition>` under a marker attribute.
 *
 * Returns the number of rules mirrored, so a caller can tell "this axis does
 * nothing here" from "this axis worked": a forced axis that silently mirrors
 * zero rules is the failure this return value exists to make visible.
 */
export function mirrorMedia(condition: string, marker: string): number {
  const parts: string[] = [];
  let mirrored = 0;

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // A cross-origin sheet cannot be read. The catalogue's own sheets are
      // bundled and same-origin, so this is a guard rather than a case.
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSMediaRule)) continue;
      if (!rule.conditionText.includes(condition)) continue;
      for (const inner of Array.from(rule.cssRules)) {
        if (!(inner instanceof CSSStyleRule)) continue;
        const selectors = inner.selectorText
          .split(",")
          .map((part) => `[${marker}] ${part.trim()}`)
          .join(", ");
        // `cssText` carries `!important` with each declaration, which is what
        // keeps the mirrored reduced-motion block as strong as the real one.
        parts.push(`${selectors} { ${inner.style.cssText} }`);
        mirrored += 1;
      }
    }
  }

  let element = document.getElementById(STYLE_ELEMENT_ID);
  if (element === null) {
    element = document.createElement("style");
    element.id = STYLE_ELEMENT_ID;
    document.head.appendChild(element);
  }
  element.textContent = parts.join("\n");
  return mirrored;
}

/** Remove the mirrored rules. */
export function clearMirroredMedia(): void {
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
}
