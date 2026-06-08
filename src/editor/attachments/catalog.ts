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
} from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";

/** One catalog row — the subset the editor render path needs. Mirrors the Rust
 *  `CatalogEntry` (`src-tauri/src/plugins/attachments/commands.rs`); hand-kept
 *  in lockstep per the no-codegen note in `src/CLAUDE.md`. */
export interface CatalogRow {
  readonly id: string;
  readonly contentType: string;
  readonly filename: string;
  readonly size: number;
}

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

/** The raw IPC shape from `plugin:attachments|catalog_list`. */
interface RawCatalogEntry {
  id: string;
  content_type: string;
  created_at: number;
  filename: string;
  size: number;
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
    const rows = await invoke<RawCatalogEntry[]>("plugin:attachments|catalog_list");
    const map = new Map<string, CatalogRow>();
    for (const r of rows) {
      map.set(r.id, {
        id: r.id,
        contentType: r.content_type,
        filename: r.filename,
        size: r.size,
      });
    }
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
    }
    destroy() {
      this.destroyed = true;
    }
  },
);

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
