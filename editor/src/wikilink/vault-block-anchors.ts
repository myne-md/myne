// Vault-wide imported-block-anchor surface for the `[[^^` autocomplete (MYND-382).
//
// The enumerate-only reading of `wikilink.md §9`: Myne never MINTS `^block-id`
// markers, it only surfaces ones that ALREADY exist (e.g. imported from
// Obsidian). The `[[^^` trigger needs block anchors ACROSS the vault — which
// neither the note-set facet (titles/folders) nor the vault-heading facet
// carries — so the host populates THIS facet with a pre-derived
// `VaultBlockAnchor[]` the same compartment-and-reconfigure way it populates the
// note-set + vault-heading facets. Mirrors `vault-headings.ts` exactly; nobody
// invents a second injection mechanism.
//
// The host derives entries from the vault-indices `[[^^` query
// (`vault_indices_block_anchors`), which is built from the single dialect
// scanner `extractBlockAnchors` (SYNC-1) — no forked block model.

import {
  Compartment,
  Facet,
  type EditorState,
  type Extension,
  type StateEffect,
} from "@codemirror/state";

/** One vault-wide imported block anchor, with just enough note context to rank,
 *  render, and emit a cross-note block deep-link (`[[Note^blockId]]`). */
export type VaultBlockAnchor = {
  noteUuid: string;
  /** Owning note title (for the row's context line + the emitted target). */
  title: string | null;
  /** Owning note `folder:` (trailing-slash form) or null/root — baked into the
   *  emitted path so same-title notes disambiguate (mirrors `VaultHeading`). */
  folder: string | null;
  /** The block id (no leading `^`), verbatim. */
  blockId: string;
  /** The tagged block's preview line (the row's primary text). */
  preview: string;
};

/** The live vault-wide block-anchor set, as seen by the `[[^^` picker. Combine
 *  takes the most-recently-provided value (the compartment provides one). */
export const vaultBlockAnchorsFacet = Facet.define<
  readonly VaultBlockAnchor[],
  readonly VaultBlockAnchor[]
>({
  combine: (inputs) => (inputs.length > 0 ? inputs[inputs.length - 1]! : []),
});

const vaultBlockAnchorsCompartment = new Compartment();

/** Compose into `myneExtensions()` — seeds the facet empty until the host
 *  reconfigures it with the derived vault block anchors. */
export function vaultBlockAnchorsExtension(): Extension {
  return vaultBlockAnchorsCompartment.of(vaultBlockAnchorsFacet.of([]));
}

/** Read the current vault-block-anchor set (`view.state`). */
export function readVaultBlockAnchors(
  state: EditorState,
): readonly VaultBlockAnchor[] {
  return state.facet(vaultBlockAnchorsFacet);
}

/** The effect the host dispatches when the vault-block-anchor set changes. */
export function reconfigureVaultBlockAnchors(
  anchors: readonly VaultBlockAnchor[],
): StateEffect<unknown> {
  return vaultBlockAnchorsCompartment.reconfigure(
    vaultBlockAnchorsFacet.of(anchors),
  );
}
