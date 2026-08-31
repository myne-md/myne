// Importer — the source seam (importer-breadth epic, MYND-579).
//
// The shipped importer was a two-phase walk hard-wired to a directory tree of
// `.md` files: Phase 1 recursed directories applying the `.md`-only
// `classifyEntry` taxonomy, Phase 2 read each queued path and ingested it. Phase 2
// was already source-agnostic (it operates on markdown and owns conflict dedup,
// folder derivation, media, cancellation, progress, the SYNC-4 deliberate-folders
// write); Phase 1 was the coupled half. This module is the seam that replaces it,
// so the four new sources (Evernote / generic HTML / Notion / CSV) reuse the whole
// of Phase 2 unchanged.
//
// TWO STAGES, NOT ONE GENERATOR — the load-bearing shape decision.
//
// Lazy discovery is required by the D3 discipline (`engine.ts`: "ingests SERIALLY
// — one file in RAM at a time"), so an adapter must not materialize every note's
// markdown up front. A bare `AsyncGenerator<{relPath, markdown}>` satisfies D3 but
// destroys `ImportResult.total`, which feeds the "Importing X of N" progress UI: a
// streaming source cannot know N until it has finished streaming.
//
// Splitting into `plan()` (cheap DESCRIPTORS — no note content, exactly what the
// old Phase 1 already produced) and `load()` (one item at a time) keeps both
// properties: `total` is `plan.items.length` for every source, and only one note's
// markdown is ever live.
//
// HOW A ONE-FILE-MANY-NOTES SOURCE FITS. Evernote is one `.enex` holding N notes.
// The host read-seam has NO ranged read — `import_read_file` returns the whole
// file as one `String` — so the file is in RAM in its entirety regardless. Such a
// source's `plan()` parses that single string once and records per-note slice
// indices in `ImportItemRef.handle`; `load()` slices on demand. Retaining one file
// string is precisely what D3 already sanctions (there IS one file), and the
// Evernote adapter bounds it with a size cap (MYND-581). No counting pre-pass and
// no indeterminate progress bar.

import type { CompressionTally } from "../../editor/attachments/insert";
import type { IgnoreCounts } from "./skipPredicate";

/**
 * What a walk may do with a symbolic link — mirrors the Rust `EntryLink`.
 * Only the host can resolve a link, so the decision is made there.
 *
 * `targetKey` is an **opaque** identity for the resolved target (never a path —
 * a filesystem path may not cross the IPC boundary). A walk keeps a visited set
 * of these so a cycle the host cannot see from one directory listing —
 * `a/x → b`, `b/y → a` — terminates instead of recursing forever.
 */
export type EntryLink =
  | { status: "followable"; targetKey: string }
  | { status: "outside" }
  | { status: "loop" }
  | { status: "broken" };

/** One external directory entry — mirrors the Rust `ImportDirEntry`. */
export interface ImportDirEntry {
  name: string;
  isDir: boolean;
  /** `null` for an ordinary file or directory; set when the entry is a link. */
  link: EntryLink | null;
}

/** A link the walk did not follow, named in the post-import report. */
export interface UnfollowedLink {
  /** Source-relative path of the link itself, for the needs-attention row. */
  relPath: string;
  reason: "outside" | "loop" | "broken";
}

/**
 * Decide what a tree walk does with one entry's link, recording the refusal and
 * maintaining the cycle guard. ONE definition, shared by every tree-shaped
 * adapter and by the media-index walk, because the host now resolves symlinked
 * directories for all of them: a walk that followed links without this would
 * recurse forever on a cross-linked vault.
 *
 * A symlinked FILE is always visited — reading one is re-validated within-root
 * by the read seam, and it cannot recurse.
 */
export function decideLinkedEntry(
  entry: ImportDirEntry,
  rel: string,
  visitedLinkTargets: Set<string>,
  unfollowedLinks: UnfollowedLink[],
): "visit" | "skip" {
  const link = entry.link;
  if (link === null) return "visit";
  if (link.status !== "followable") {
    unfollowedLinks.push({ relPath: rel, reason: link.status });
    return "skip";
  }
  if (!entry.isDir) return "visit";
  if (visitedLinkTargets.has(link.targetKey)) {
    unfollowedLinks.push({ relPath: rel, reason: "loop" });
    return "skip";
  }
  visitedLinkTargets.add(link.targetKey);
  return "visit";
}

/**
 * `root + "/" + rel`, tolerating a trailing slash on `root` (`rel === ""` → `root`).
 *
 * ONE definition, deliberately: the walk and the media-index resolution in
 * `ports.ts` must agree byte-for-byte, because the media index is keyed by the
 * paths the walk produced. Two copies had already diverged on trailing-slash
 * handling, which would key `root//rel` in one and `root/rel` in the other for a
 * picked root ending in `/`.
 */
export function joinPath(root: string, rel: string): string {
  if (rel.length === 0) return root;
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${base}/${rel}`;
}

/** Which source produced an import run. Used for reporting + UI copy; source
 *  names are nominative only and are never productized as Myne feature names. */
export type ImportSourceId = "obsidian" | "notion" | "evernote" | "html" | "csv";

/**
 * One discovered item, WITHOUT its content. `relPath` is the source-relative path
 * the shared mapping seam derives folder + title from, so a source that has no real
 * filesystem (e.g. `.enex`) still synthesizes a meaningful one.
 */
export interface ImportItemRef {
  relPath: string;
  /** Source-private handle (an `.enex` slice index, a zip entry, …). The engine
   *  passes it back to `load()` verbatim and never inspects it. */
  handle?: unknown;
}

/** The cheap enumeration pass — descriptors + the tallies the summary DTO needs. */
export interface ImportPlan {
  /** Items to ingest, in ingest order. `length` is the progress denominator. */
  items: ImportItemRef[];
  /** Every directory seen, for SYNC-4 empty-dir detection. Empty for sources
   *  with no directory structure. */
  dirs: string[];
  /** SYNC-10 skip tallies (canvas / excalidraw / non-markdown / hidden). */
  ignore: IgnoreCounts;
  /**
   * Symbolic links the walk did not follow — one row each in the post-import
   * "needs attention" list. A refused link is reported BY NAME rather than
   * counted, because what sits behind it is a subtree of unknown size and a
   * muted "other files skipped 1" reads like a stray `.png` (myne-md/myne#223).
   * Empty for a source with no directory structure.
   */
  unfollowedLinks: UnfollowedLink[];
}

/** One item's content, plus what the source could not represent. */
export interface LoadedItem {
  /** The note markdown. For non-markdown sources this is already converted. */
  markdown: string;
  /**
   * Names of constructs this item carried that have no target in Myne's dialect
   * (a Notion toggle, an `<iframe>`, a dropped URL scheme, …). Drives the
   * per-note lossy flag: HTML→markdown loses things INSIDE notes that still count
   * as successfully imported, and a per-construct counter has no honest integer
   * for that. The engine collects these; MYND-585 turns them into the generated
   * import-report note. Empty for a lossless source like Obsidian `.md`.
   */
  lossy: readonly string[];
  /**
   * Ingest-time image compression this item's OWN media ingest performed, for a
   * source that ingests inside `load()` rather than through the engine's
   * `importMedia` port (Evernote inlines its resources as base64, so it has no
   * media path for that port to resolve).
   *
   * Absent for every path-based source: there the engine tallies
   * `processImportedMedia`'s own report instead, and a source reporting the same
   * bytes twice would double-count them. `decisions.md` 2026-07-30 makes the
   * disclosure at import what stands in for a consent gate, so a route that
   * ingests images without reaching that port still owes the user a tally —
   * this is how it hands one over.
   */
  compression?: CompressionTally;
}

/**
 * A source of importable notes. `plan()` enumerates cheaply; `load()` is called
 * serially, once per item, by the engine's ingest loop.
 */
export interface ImportSource {
  readonly id: ImportSourceId;
  plan(): Promise<ImportPlan>;
  load(ref: ImportItemRef): Promise<LoadedItem>;
}

/**
 * The WRITE half of the importer's IO — what the ingest loop needs once a source
 * has handed it markdown. Splitting read (source) from write (sink) is what lets
 * one ingest loop serve every source. `ImportPorts` EXTENDS this, so existing
 * callers pass their ports object unchanged and the two cannot drift.
 */
export interface ImportSink {
  /** Encrypt + write one note; returns its id. */
  createNote(plaintext: string): Promise<string>;
  /** Persist the importer's empty-dir folders (the impl unions with existing prefs). */
  /**
   * Register folders the import created. Returns how many additions the
   * reserved byte budget refused (myne-md/myne#613): zero in every ordinary
   * case, non-zero on a vault large enough to overflow the reserve, and the
   * number the report shows the user.
   */
  setDeliberateFolders(folders: readonly string[]): Promise<number>;
}

/**
 * Injected IO for a directory-backed source (Tauri commands in production, fakes in
 * tests). Lives on the seam rather than in the engine so an adapter depends on the
 * seam only — the engine depends on adapters, not the reverse.
 */
export interface ImportPorts extends ImportSink {
  /** List a directory's entries (name + isDir, no content). */
  readDir(absPath: string): Promise<ImportDirEntry[]>;
  /** Read a file's UTF-8 source bytes. */
  readFile(absPath: string): Promise<string>;
  /**
   * Take or drop a short lease that DEFERS the host's idle auto-lock while an
   * import runs (myne-md/myne#223). Optional because it is a property of the
   * HOST, not of the import: only the desktop client has an OS-idle timer the
   * import is invisible to. Omitted, the import simply does not defer anything.
   */
  setImportHold?(active: boolean): Promise<void>;
}

/** One note that imported successfully but lost representable detail on the way. */
export interface LossyNote {
  /** Source-relative path, for the report row. */
  relPath: string;
  /** The folder the note was actually filed under. */
  folder: string | null;
  /** The note's read-time title — the report links to it by title. */
  title: string;
  /** Construct names the source could not represent. Never empty. */
  dropped: readonly string[];
}
