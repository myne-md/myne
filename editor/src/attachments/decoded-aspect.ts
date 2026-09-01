// The decoded aspect ratio of every image this vault has rendered, keyed by
// attachment id.
//
// # Why this is its own file rather than sitting in `widgets.ts`
//
// It used to live there, and the two lines that clear it on vault teardown
// (`src/lib/vault-unlock.ts`, `src/lib/vault-switch.ts`) therefore imported
// `widgets.ts` at module scope. `src/App.tsx` imports `vault-unlock` eagerly,
// so that one import put the whole attachment-widget subtree, `pdf-reader`,
// `lightbox`, `waveform`, `transcript` and CodeMirror among it, into the app's
// EAGER graph. Everything there had previously been reachable only from the
// lazily-loaded editor chunk, and the web client's first load grew by 42.7 KiB
// gzip, measured, against a clean base.
//
// Nothing about clearing a `Map` needs any of that. So the store is a leaf with
// no imports at all, `widgets.ts` reads it from here, and the teardown paths
// import the leaf instead. The heavy subtree goes back to being lazy.
//
// # Why it is cleared at all
//
// The ratio makes an image's box reservable before a single byte is decoded, so
// a rebuild lands on exactly the height it left. Ratio rather than pixels
// because the WIDTH is the layout's to decide (`w=`, the 320px default cap, the
// aligned `fit-content` form); only the height follows from the image itself.
//
// The key is an attachment id and the value is derived from decrypted content,
// so the map is an enumeration of every attachment this vault has rendered.
// That is a live record of what the vault contains, which is the same reasoning
// that puts the scroll map and the recency order on the teardown roster. The
// cost of clearing it is one first-paint settle after a re-unlock.

const decodedAspect = new Map<string, number>();

/** The ratio remembered for `id`, or `undefined` if none is known yet. */
export function decodedAspectOf(id: string): number | undefined {
  return decodedAspect.get(id);
}

/** Remember one image's shape, once it is known. */
export function rememberAspect(id: string, img: HTMLImageElement): void {
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    decodedAspect.set(id, img.naturalWidth / img.naturalHeight);
  }
}

/** Forget every remembered ratio.
 *
 * Called on both vault-leaving paths (`lockVault`, `leaveActiveVault`) and
 * asserted there by `scripts/check-frontend-lock-teardown.mjs`, alongside the
 * scroll map and the recency order. */
export function resetDecodedAspects(): void {
  decodedAspect.clear();
}
