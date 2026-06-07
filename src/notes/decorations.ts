// Sidebar decorations — color-label slots (MYND-184) shared constants.
//
// The six fixed, muted, hue-named color slots. Their themed `--label-<slot>`
// CSS variables live in `src/styles/tokens.css` (light + dark pairs). This is
// the single source of the slot LIST + display names so the picker, the dot,
// and any future consumer can't drift. The custom-folder-icon glyph set
// (MYND-185) is a sibling concern landing in `src/notes/folderIcons.ts`.

/** The six color-label slots, in picker display order (MYND-184). */
export const LABEL_SLOTS = [
  "clay",
  "ochre",
  "moss",
  "slate",
  "plum",
  "stone",
] as const;

export type LabelSlot = (typeof LABEL_SLOTS)[number];

/** Human-facing slot names — the swatch `aria-label` / tooltip. */
export const LABEL_SLOT_NAMES: Record<LabelSlot, string> = {
  clay: "Clay",
  ochre: "Ochre",
  moss: "Moss",
  slate: "Slate",
  plum: "Plum",
  stone: "Stone",
};

/** CSS color value for a slot — the themed `--label-*` token (resolves per
 *  theme via `:root` / `[data-theme="dark"]` / the `prefers-color-scheme`
 *  media block). Unknown slot names still produce a (likely-invalid) var(),
 *  which CSS renders as transparent — matching the "ignore unknown slot at
 *  render" decode discipline. */
export function labelColorVar(slot: string): string {
  return `var(--label-${slot})`;
}
