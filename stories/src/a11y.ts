// Accessibility facts for the rendered story (myne-md/myne#845).
//
// A per-story VIEW, not a gate: the real assertions live in `tests/a11y/*` and
// the axe lane, and the inspector says so. What this adds is the ability to read
// the facts for the component in front of you, against the theme you have
// selected, which no suite can show in place.
//
// Pure functions over an Element, so they are unit-testable without a browser
// beyond jsdom.

export interface RoleName {
  role: string;
  name: string;
}

/** Elements carrying an explicit ARIA role, with the best accessible name. */
export function roleNames(root: Element): RoleName[] {
  const out: RoleName[] = [];
  for (const element of root.querySelectorAll("[role]")) {
    const role = element.getAttribute("role");
    if (role === null) continue;
    out.push({ role, name: accessibleName(element) });
  }
  return out;
}

/** The name a screen reader would announce: aria-label, else text content. */
export function accessibleName(element: Element): string {
  const label = element.getAttribute("aria-label");
  if (label !== null && label.trim().length > 0) return label.trim();
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (parts.length > 0) return parts;
  }
  return (element.textContent ?? "").trim().slice(0, 80);
}

const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

/** Focusable elements in DOM order, which is the Tab order absent a tabindex. */
export function focusOrder(root: Element): string[] {
  return [...root.querySelectorAll(FOCUSABLE)]
    .filter((element) => element.getAttribute("tabindex") !== "-1")
    .map((element) => {
      const tag = element.tagName.toLowerCase();
      const label = accessibleName(element);
      return label.length > 0 ? `${tag} "${label}"` : tag;
    });
}

/** The 24px floor the canon states, read from the token so it cannot drift. */
function targetFloor(documentElement: Element): number {
  const value = getComputedStyle(documentElement).getPropertyValue("--target-min");
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 24;
}

/** Pointer targets smaller than the floor the canon sets. */
export function targetSizeFindings(root: Element): string[] {
  const floor = targetFloor(root.ownerDocument.documentElement);
  const out: string[] = [];
  for (const element of root.querySelectorAll("button, a[href], input, select, textarea")) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    if (box.height < floor || box.width < floor) {
      out.push(
        `${element.tagName.toLowerCase()} ${Math.round(box.width)}x${Math.round(box.height)} (floor ${floor})`,
      );
    }
  }
  return out;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColour(value: string): Rgb | null {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1].split(",").map((part) => Number.parseFloat(part));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
}

function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** The nearest opaque background above `element`, which is what paints behind it. */
function effectiveBackground(element: Element, fallback: Rgb): Rgb {
  let node: Element | null = element;
  while (node !== null && node !== element.ownerDocument.documentElement) {
    const colour = parseColour(getComputedStyle(node).backgroundColor);
    if (colour !== null && colour.a > 0.5) return colour;
    node = node.parentElement;
  }
  return fallback;
}

const AA_NORMAL = 4.5;
const AA_LARGE = 3;

/**
 * Text below the WCAG AA threshold against its effective background.
 *
 * Measured against the ACTIVE theme, because the values come from computed
 * style: switching the theme and calling this again is what makes a verdict
 * meaningful rather than theme-blind.
 */
export function failingContrast(root: Element): string[] {
  const document = root.ownerDocument;
  const pageBackground = parseColour(
    getComputedStyle(document.documentElement).backgroundColor,
  ) ?? { r: 255, g: 255, b: 255, a: 1 };

  const out: string[] = [];
  for (const element of root.querySelectorAll("*")) {
    if (element.children.length > 0) continue;
    const text = (element.textContent ?? "").trim();
    if (text.length === 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") continue;
    const foreground = parseColour(style.color);
    if (foreground === null) continue;
    const background = effectiveBackground(element, pageBackground);
    const ratio = contrastRatio(foreground, background);
    const size = Number.parseFloat(style.fontSize) || 16;
    const bold = (Number.parseInt(style.fontWeight, 10) || 400) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? AA_LARGE : AA_NORMAL;
    if (ratio < need) {
      out.push(`${ratio.toFixed(2)} (needs ${need}) "${text.slice(0, 30)}"`);
    }
  }
  return out;
}
