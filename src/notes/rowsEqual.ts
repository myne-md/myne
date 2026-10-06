// Identity-stable async-fetch guard for the vault-wide picker sets
// (`useVaultHeadings`, `useVaultBlockAnchors`).
//
// Both hooks refetch on the SYNC-5 index nonce, and `vaultIndicesApply` bumps
// that nonce on EVERY autosave (`reindexNoteFromBody`). Without a guard the
// fetch's `setRows(fetched)` allocates a fresh array each time even when the
// note's headings/anchors did not change, so the hook returned a new identity,
// so `CMEditor` reconfigured its facet and every consumer re-rendered on every
// save. On a long note that showed as a flicker each time the autosave fired.
//
// Collapses that to a no-op when the fetched value deep-equals what is already
// resident. These sets are small (one row per heading/anchor across the vault)
// and flat (string + number fields), so a field-wise compare costs far less than
// the IPC it follows.

/** Shallow field-wise equality for two plain record arrays, given their keys.
 *  `null`/`undefined` and array order are significant, which is correct: a
 *  reordered set genuinely changes what the picker shows. */
export function rowsEqual<T extends Record<string, unknown>>(
  a: readonly T[],
  b: readonly T[],
  keys: readonly (keyof T)[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    for (const k of keys) {
      if (x[k] !== y[k]) return false;
    }
  }
  return true;
}
