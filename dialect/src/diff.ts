// Minimal hand-rolled line diff (MYND-97, SYNC-10). Added/removed/unchanged
// lines between two texts — NO external dependency (the minimum-direct-dep /
// TB9 discipline; `@codemirror/merge` was rejected in the file-recovery-ui
// grill). LCS-based, which is plenty for note-sized content; a coarse fallback
// bounds memory for pathologically large inputs.
//
// Lifted out of the desktop `src/notes/lineDiff.ts` into `@myne/dialect`
// (MYND-334, following the SYNC-45 conflict-copy precedent) so the desktop
// snapshot panel, the desktop conflict view and the mobile client all diff
// through one implementation instead of three drifting copies. Behaviour is
// unchanged by the move.
//
// Pure text-in → diff-out: no IO, no note knowledge, no normalization (callers
// normalize first). That keeps it trivially inside the platform-seam rule — a
// pure string function takes zero `@tauri-apps/*` imports by construction.

export type DiffLine =
  | { type: "same"; text: string }
  | { type: "add"; text: string }
  | { type: "del"; text: string };

// Above this many lines on either side, skip the O(n·m) LCS table and fall back
// to a coarse "everything replaced" diff (bounded memory). Notes are normally
// far smaller; this only guards a 16 MiB worst case.
const LCS_LINE_CAP = 5000;

/**
 * Compute a line-level diff transforming `oldText` into `newText`.
 * Returns the lines in output order, each tagged `same` / `add` (present only
 * in new) / `del` (present only in old).
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  if (n > LCS_LINE_CAP || m > LCS_LINE_CAP) {
    // Coarse fallback: show the whole old block removed, the whole new added.
    return [
      ...a.map((text): DiffLine => ({ type: "del", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ];
  }

  // dp[i][j] = LCS length of a[i..] and b[j..].
  const dp: number[][] = Array.from(
    { length: n + 1 },
    () => new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i] });
    i++;
  }
  while (j < m) {
    out.push({ type: "add", text: b[j] });
    j++;
  }
  return out;
}

/** Count of changed (added + removed) lines — for a compact "N changes" summary. */
export function changedLineCount(diff: DiffLine[]): number {
  return diff.reduce((acc, d) => (d.type === "same" ? acc : acc + 1), 0);
}
