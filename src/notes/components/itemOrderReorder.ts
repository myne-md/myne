// Thin re-export shim (MYND-596): the pure `item_order` reorder computation +
// the dual-write orchestration now live in the shared
// `@myne/editor/host/notes/itemOrder` module, consumed as SOURCE by both the
// desktop and mobile clients. Desktop consumers keep importing from
// `./itemOrderReorder`; this file only forwards the shared surface (the same
// dialect-shim precedent as `src/dialect/*` — a re-export with no logic of its
// own).
//
// `item_order` is now a container-keyed map (MYND-596): `computeItemOrderAfterReorder`
// rewrites ONE container's sequence; `reorderSequence` is the pure single-sequence
// reorder shared by favorites and one item_order container.

export {
  itemOrderKey,
  computeItemOrderAfterReorder,
  reorderSequence,
  applyReorderWrite,
} from "@myne/editor/host/notes/itemOrder";
export type {
  ReorderOutcome,
  ReorderPlace,
} from "@myne/editor/host/notes/itemOrder";
