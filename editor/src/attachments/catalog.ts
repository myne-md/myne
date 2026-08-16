// Attachment-catalog resolution for the editor (epic MYND-164, sub-feature
// editor-image-embeds).
//
// Form-C embeds `![[att:<id>|filename]]` resolve their id against the vault's
// `MYC1` catalog (the `catalog_list` IPC command). Decorations are SYNCHRONOUS
// (CM6 builds a `DecorationSet` from current state), but the catalog read is an
// async IPC round-trip — so this module loads the catalog ONCE per editor mount,
// caches it in a `StateField`, and dispatches a `StateEffect` when it arrives so
// the decorations rebuild against the populated map.
//
// The cached row is the metadata the chip needs (filename, content-type) plus a
// `present` flag. Resolution has three outcomes the renderer distinguishes:
//   - `resolved`   — id is in the catalog → render the inline image / PDF
//   - `deleted`    — catalog has loaded AND the id is absent → "deleted" tombstone
//   - `loading`    — catalog hasn't loaded yet → a neutral pending chip
// A malformed `att:` target (caught upstream by `parseAttachmentTarget`) is a
// "broken reference", handled by the decoration, not here.

import {
  type Extension,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { getHost } from "../host";
import { extractAttachmentIds } from "../host/notes/attachmentRef";

/** One catalog row — the subset the editor render path needs.
 *
 * Moved to the host seam with phase3-web-client task 76: the host now shapes
 * the rows, so the type belongs to the contract rather than to this consumer.
 * Re-exported unchanged so every existing importer of `./catalog` still works. */
export type { CatalogRow } from "../host";
import type { CatalogRow } from "../host";

/** The catalog as resolved into editor state: `null` until the IPC load
 *  resolves (loading), then a `Map<id, row>` (possibly empty). */
export type CatalogState = ReadonlyMap<string, CatalogRow> | null;

/** Dispatched when `catalog_list` resolves; carries the id→row map. */
const setCatalog = StateEffect.define<ReadonlyMap<string, CatalogRow>>();

/** Holds the resolved catalog. `null` = not loaded yet (pending). */
export const catalogField = StateField.define<CatalogState>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCatalog)) return effect.value;
    }
    return value;
  },
});

/**
 * Optimistically merge freshly-imported rows into the cached catalog so a
 * just-pasted/dropped embed resolves to its image IMMEDIATELY, instead of
 * rendering a "deleted" tombstone until a note-reopen reloads the catalog.
 * The catalog loads once per editor mount (the loader plugin), so without this
 * a new attachment isn't in `catalogField` when its embed decoration builds.
 * The host has already persisted these rows (import writes the `MYC1` catalog
 * before returning), so this merely front-runs the next full load. No-op
 * before the catalog has loaded is avoided by treating an unloaded field as an
 * empty map — the loader's later dispatch reconciles the full set.
 */
export function addCatalogRows(
  view: EditorView,
  rows: readonly CatalogRow[],
): void {
  if (rows.length === 0) return;
  const current = view.state.field(catalogField, false) ?? null;
  const next = new Map<string, CatalogRow>(current ?? []);
  for (const r of rows) next.set(r.id, r);
  view.dispatch({ effects: setCatalog.of(next) });
}

/**
 * Fetch the catalog over IPC and shape it into an id→row map. Swallows any IPC
 * failure into an empty map (the read is `Slot::Unlocked`-gated host-side and
 * falls back to empty per §9.10.4; a locked slot / transient error just shows
 * loading→empty, which renders attachments as tombstones until the next load).
 * Overridable in tests via {@link setCatalogLoader}.
 */
type CatalogLoader = () => Promise<ReadonlyMap<string, CatalogRow>>;

let loadCatalog: CatalogLoader = async () => {
  try {
    const rows = await getHost().attachments.catalogList();
    const map = new Map<string, CatalogRow>();
    for (const r of rows) map.set(r.id, r);
    return map;
  } catch {
    return new Map();
  }
};

/** Override the catalog loader (tests only). Returns a restore fn. */
export function setCatalogLoader(loader: CatalogLoader): () => void {
  const prev = loadCatalog;
  loadCatalog = loader;
  return () => {
    loadCatalog = prev;
  };
}

/**
 * A ViewPlugin that kicks off the catalog load once on mount and dispatches the
 * result into `catalogField`. Re-fetch on demand is out of scope here — the
 * library's import/delete flows live in sibling agents' surfaces; a note reopen
 * (fresh editor mount) re-loads. Guards against dispatching into a destroyed
 * view (the async resolve can outlive a quick note switch).
 */
const catalogLoaderPlugin = ViewPlugin.fromClass(
  class {
    private destroyed = false;
    constructor(view: EditorView) {
      void loadCatalog().then((map) => {
        if (this.destroyed) return;
        view.dispatch({ effects: setCatalog.of(map) });
      });
      // Ask the host to make this DOCUMENT's attachment refs resolvable
      // (phase3-web-client task 44). Desktop omits `warmRefs` and this is a
      // no-op; a browser decrypts those attachments and mints their object URLs,
      // because its `resolveRef` cannot do IO inside a render.
      //
      // Scoped to the ids the open note actually embeds, NOT the whole catalog:
      // warming the catalog would decrypt every attachment in the vault on every
      // note open, which for an attachment-heavy vault is gigabytes to answer a
      // question about one note.
      void this.warm(view);
    }

    /** Warm the doc's refs, then repaint so the resolved URLs are picked up. */
    private async warm(view: EditorView): Promise<void> {
      const warmRefs = getHost().attachments.warmRefs;
      if (warmRefs === undefined) return;
      const ids = extractAttachmentIds(view.state.doc.toString());
      if (ids.length === 0) return;
      try {
        await warmRefs(ids);
      } catch {
        // Best-effort: a host that cannot warm leaves the refs unresolved, which
        // its `resolveRef` already has an answer for.
        return;
      }
      if (this.destroyed) return;
      // The decorations were built against the pre-warm answers, so they have to
      // be rebuilt. Re-dispatching the SAME map reference was inert: the embed
      // plugin rebuilds only when `catalogField`'s VALUE changes, so the widgets
      // kept their pre-warm (placeholder) URLs and never repainted (#211). Copy
      // the map so the field reference genuinely changes — same content, new
      // identity — which flips `catalogChanged` and rebuilds the embeds against
      // the now-resolved object URLs.
      const current = view.state.field(catalogField, false);
      if (current != null) view.dispatch({ effects: setCatalog.of(new Map(current)) });
    }

    destroy() {
      this.destroyed = true;
    }
  },
);

/**
 * Did this transaction change the catalog?
 *
 * The non-obvious rebuild trigger for anything that renders an attachment: the
 * document is byte-identical before and after a warm, so a decoration field
 * guarded on `tr.docChanged` alone keeps its pre-warm placeholder URLs forever
 * (#211). Lives here because this module owns the field.
 *
 * Two `StateField`s use it (`cover-banner.ts`, `frontmatter.ts`).
 * `attachment-embed.ts` deliberately does NOT: it is a `ViewPlugin` comparing a
 * `ViewUpdate`, not a `Transaction`, so it keeps its own comparison until
 * someone adds an overload. Saying otherwise would hide a duplicate that is
 * still there.
 */
export function catalogChanged(tr: Transaction): boolean {
  return tr.startState.field(catalogField, false) !== tr.state.field(catalogField, false);
}

/** Resolve an attachment id against the current catalog state. */
export type CatalogResolution =
  | { readonly kind: "loading" }
  | { readonly kind: "resolved"; readonly row: CatalogRow }
  | { readonly kind: "deleted" };

export function resolveCatalog(
  catalog: CatalogState,
  id: string,
): CatalogResolution {
  if (catalog === null) return { kind: "loading" };
  const row = catalog.get(id);
  return row !== undefined ? { kind: "resolved", row } : { kind: "deleted" };
}

/** The catalog extension bundle: the field + the loader plugin. */
export function attachmentCatalogExtension(): readonly Extension[] {
  return [catalogField, catalogLoaderPlugin];
}
