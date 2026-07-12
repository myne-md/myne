// Wikilink chip widget barrel — exports the chip rendering + atomic-range
// extensions consumed by `src/editor/extensions.ts`.
//
// Parser lives in `src/dialect/lezer/wikilink.ts` (shipped via MYND-42);
// this directory ships only the editor-side rendering layer. The authoring
// layer (autocomplete picker, hover-tooltip resolution, manual conversion,
// auto-update on rename) lands in the future `editor-mvp-wikilinks` PRD.

export {
  WikilinkChipWidget,
  chipDisplayText,
  parseWikilinkParts,
  wikilinkAtomicRanges,
  wikilinkChipExtensions,
  type WikilinkParts,
} from "./chip-widget";
// Anchor (heading / imported block-id) deep-link resolution (MYND-305).
export {
  findBlockOffset,
  findHeadingOffset,
  findQueryRange,
  hasAnchor,
  resolveAnchorOffset,
  resolveAnchorRange,
  type AnchorRange,
  type WikilinkAnchor,
} from "./anchor";
