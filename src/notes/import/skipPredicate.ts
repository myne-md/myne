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
  /** An Obsidian Excalidraw drawing (`.excalidraw.md` / `.excalidraw`).
   *  Reported rather than imported (MYND-633) — see {@link classifyEntry}. */
  | "excalidraw-skipped"
  | "non-markdown-skipped"
  | "hidden-ignored";

/**
 * Classify one directory-entry name into exactly one SYNC-10 bucket.
 *
 * The walk (sub-feature 3) applies this with file/dir context: for a
 * **directory**, only a `hidden-ignored` result is actionable (a dot-dir like
 * `.obsidian/` is skipped + counted); a non-dot directory is recursed into, so
 * its `non-markdown-skipped` classification is irrelevant and never tallied.
 * For a **file**, every skip bucket applies — route it through
 * {@link tallyEntry} rather than an inline chain, so a bucket added here cannot
 * be forgotten there. This function is name-only and pure — it does not (and
 * cannot) tell a file from a directory.
 */
export function classifyEntry(name: string): EntryClass {
  if (name.startsWith(".")) return "hidden-ignored"; // rule (i) — wins
  const lower = name.toLowerCase(); // case-insensitive extension match
  // MYND-633: `.excalidraw.md` BEFORE the plain `.md` arm — it ends in `.md`,
  // so it was passing the markdown filter and being imported as an ordinary
  // note. Obsidian's Excalidraw plugin stores a drawing as a markdown wrapper
  // around its own serialized scene, so what landed in the vault was that
  // wrapper rendered as prose: a "# Excalidraw Data" heading, an
  // "## Text Elements" dump and a fenced blob. That is the reported corruption
  // — nothing was mangled in transit, the file was never a note to begin with.
  if (lower.endsWith(".excalidraw.md") || lower.endsWith(".excalidraw")) {
    return "excalidraw-skipped";
  }
  if (lower.endsWith(".md")) return "import-as-note";
  if (lower.endsWith(".canvas")) return "canvas-skipped";
  return "non-markdown-skipped";
}

/**
 * The skip-count fields this sub-feature contributes to the frozen SYNC-2
 * summary DTO (owned/rendered by sub-feature 3): `.canvas` skipped (its own
 * line), Excalidraw drawings skipped (its own line, MYND-633), non-markdown
 * skipped, and the low-profile hidden/config transparency count.
 * `import-as-note` contributes to none of these (it is imported, counted as
 * "imported" elsewhere).
 */
export interface IgnoreCounts {
  canvasSkipped: number;
  /** Obsidian Excalidraw drawings reported instead of imported (MYND-633). */
  excalidrawSkipped: number;
  nonMarkdownSkipped: number;
  hiddenIgnored: number;
}

export function emptyIgnoreCounts(): IgnoreCounts {
  return {
    canvasSkipped: 0,
    excalidrawSkipped: 0,
    nonMarkdownSkipped: 0,
    hiddenIgnored: 0,
  };
}

/**
 * Route ONE classification into its SYNC-2 count field. Mutates `counts`.
 *
 * This is the single tally site, and the `switch` is exhaustive over
 * {@link EntryClass} with a `never` default, so adding a bucket to that union
 * is a compile error until it is counted somewhere. Every adapter walk calls
 * this instead of writing its own `if` chain.
 *
 * That is not a style preference. MYND-633 added `excalidraw-skipped` to the
 * union and to this roll-up, but the Obsidian walk carried its own inline
 * chain ending in a catch-all `else` — so drawings were counted as hidden
 * config entries and the dedicated summary row could never leave 0, while the
 * spec's own tests stayed green because the function they exercised was not
 * the function that ran (myne-md/myne#223).
 */
export function tallyEntry(counts: IgnoreCounts, cls: EntryClass): void {
  switch (cls) {
    case "import-as-note":
      return; // imported, not skipped — counted as "imported" elsewhere
    case "canvas-skipped":
      counts.canvasSkipped++;
      return;
    case "excalidraw-skipped":
      counts.excalidrawSkipped++;
      return;
    case "non-markdown-skipped":
      counts.nonMarkdownSkipped++;
      return;
    case "hidden-ignored":
      counts.hiddenIgnored++;
      return;
    default: {
      const exhaustive: never = cls;
      return exhaustive;
    }
  }
}

/** Roll a list of classifications into the SYNC-2 count fields. */
export function tallyIgnore(classes: readonly EntryClass[]): IgnoreCounts {
  const counts = emptyIgnoreCounts();
  for (const c of classes) tallyEntry(counts, c);
  return counts;
}
