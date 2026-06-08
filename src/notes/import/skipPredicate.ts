// Obsidian importer — two-rule ignore-set classification (SYNC-10).
//
// Sub-feature 5 of the obsidian-importer epic (MYND-54), task 1.
//
// A pure classifier for a single directory-entry name (no walk, no I/O — the
// walk that applies this per entry is sub-feature 3's engine). Two rules, in
// order:
//   (i)  any dot-prefixed name (file OR dir, any depth) → `hidden-ignored`,
//        checked BEFORE extension dispatch so it wins (subsumes `.obsidian/`,
//        `.git/`, `.trash/`, `.DS_Store`, `.obsidian.vimrc`, and the `.foo.md`
//        edge — a dot-prefixed "note" is silently dropped, by design).
//   (ii) of non-dot entries: only `.md` → `import-as-note`; `.canvas` →
//        `canvas-skipped` (its own bucket — Obsidian's whiteboard is a
//        `vision.md` anti-feature, skip-and-report upholds it); everything else
//        → `non-markdown-skipped` (`.markdown` and `.mdx` are NOT importable —
//        `.mdx` is JSX, a parser/C1 risk). Extension compare is case-insensitive.
//
// Skipping writes nothing to disk, so the C1 sanctioned-diff allowlist (SYNC-9)
// is untouched.

export type EntryClass =
  | "import-as-note"
  | "canvas-skipped"
  | "non-markdown-skipped"
  | "hidden-ignored";

/**
 * Classify one directory-entry name into exactly one SYNC-10 bucket.
 *
 * The walk (sub-feature 3) applies this with file/dir context: for a
 * **directory**, only a `hidden-ignored` result is actionable (a dot-dir like
 * `.obsidian/` is skipped + counted); a non-dot directory is recursed into, so
 * its `non-markdown-skipped` classification is irrelevant and never tallied.
 * For a **file**, all four buckets apply. This function is name-only and pure —
 * it does not (and cannot) tell a file from a directory.
 */
export function classifyEntry(name: string): EntryClass {
  if (name.startsWith(".")) return "hidden-ignored"; // rule (i) — wins
  const lower = name.toLowerCase(); // case-insensitive extension match
  if (lower.endsWith(".md")) return "import-as-note";
  if (lower.endsWith(".canvas")) return "canvas-skipped";
  return "non-markdown-skipped";
}

/**
 * The three skip-count fields this sub-feature contributes to the frozen SYNC-2
 * summary DTO (owned/rendered by sub-feature 3): `.canvas` skipped (its own
 * line), non-markdown skipped, and the low-profile hidden/config transparency
 * count. `import-as-note` contributes to none of these (it is imported, counted
 * as "imported" elsewhere).
 */
export interface IgnoreCounts {
  canvasSkipped: number;
  nonMarkdownSkipped: number;
  hiddenIgnored: number;
}

export function emptyIgnoreCounts(): IgnoreCounts {
  return { canvasSkipped: 0, nonMarkdownSkipped: 0, hiddenIgnored: 0 };
}

/** Roll a list of classifications into the three SYNC-2 count fields. */
export function tallyIgnore(classes: readonly EntryClass[]): IgnoreCounts {
  const counts = emptyIgnoreCounts();
  for (const c of classes) {
    if (c === "canvas-skipped") counts.canvasSkipped++;
    else if (c === "non-markdown-skipped") counts.nonMarkdownSkipped++;
    else if (c === "hidden-ignored") counts.hiddenIgnored++;
  }
  return counts;
}
