// Vault-wide heading surface for the `[[##` autocomplete (MYND-305).
//
// The `[[#` trigger reads the CURRENT note's headings straight from the live
// document (`headingSections(view.state.doc)`), so it needs no facet. The `[[##`
// trigger needs headings ACROSS the vault — which the note-set facet
// (titles/folders only) doesn't carry — so the host populates THIS facet with a
// pre-derived `VaultHeading[]` the same way it populates the note-set facet
// (compartment + reconfigure, re-mount-free). Mirrors `note-set.ts` exactly;
// nobody invents a second injection mechanism.
//
// Each entry is one heading in one note: enough to fuzzy-rank it, render the
// "heading · note context" row, and emit the full §3.5 path form. The host
// derives entries via the canonical `headingSections` surface (SYNC-1) — no
// forked heading model, no block index (§9).

import {
  Compartment,
  Facet,
  type EditorState,
  type Extension,
  type StateEffect,
} from "@codemirror/state";

/** One vault-wide heading, with just enough note context to rank, render, and
 *  emit a cross-note deep-link. */
export type VaultHeading = {
  noteUuid: string;
  /** Owning note title (for the row's context line + the emitted alias). */
  title: string | null;
  /** Owning note `folder:` (trailing-slash form) or null/root — baked into the
   *  emitted path. */
  folder: string | null;
  /** The heading text (markers stripped, as `headingSections` produces). */
  heading: string;
  /** 1..6 — drives a subtle indent/scale in the row, like the heading outline. */
  level: number;
};

/** The live vault-wide heading set, as seen by the `[[##` picker. Combine takes
 *  the most-recently-provided value (the compartment provides exactly one). */
export const vaultHeadingsFacet = Facet.define<
  readonly VaultHeading[],
  readonly VaultHeading[]
>({
  combine: (inputs) => (inputs.length > 0 ? inputs[inputs.length - 1]! : []),
});

const vaultHeadingsCompartment = new Compartment();

/** Compose into `myneExtensions()` — seeds the facet empty until the host
 *  reconfigures it with the derived vault headings. */
export function vaultHeadingsExtension(): Extension {
  return vaultHeadingsCompartment.of(vaultHeadingsFacet.of([]));
}

/** Read the current vault-heading set (`view.state`). */
export function readVaultHeadings(state: EditorState): readonly VaultHeading[] {
  return state.facet(vaultHeadingsFacet);
}

/** The effect the host dispatches when the vault-heading set changes. */
export function reconfigureVaultHeadings(
  headings: readonly VaultHeading[],
): StateEffect<unknown> {
  return vaultHeadingsCompartment.reconfigure(vaultHeadingsFacet.of(headings));
}
