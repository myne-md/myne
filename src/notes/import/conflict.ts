// Obsidian importer — conflict / duplicate handling (idempotent re-import).
//
// Sub-feature 2 of the obsidian-importer epic (MYND-50), tasks 1–3 (SYNC-5).
//
// MYND-50 was re-scoped from "skip/overwrite/rename" to idempotent re-import:
// "overwrite" is structurally impossible (note_create mints a backend UUIDv7,
// create-only) and duplicate (folder, title) pairs are legal. So the only real
// behavior is: before each `note_create`, check whether a LIVE note with the
// same (folder, title) identity already exists, and — under the default toggle
// — skip it (never overwrite, never update; C1 + no lost edits).
//
// Identity = the SAME case-fold + NFC fold the daily-note resolver uses
// (`folderKey` + `foldSegment(title)`), so the importer's match key is the
// resolver's key, not a second scheme (not content-hash, not source-path).
//
// Identity coverage: for every PATH-BASED source the importer injects `title:`
// from the source filename when an imported file has no frontmatter `title:` of
// its own (the §6 sanctioned transform, `decisions.md` 2026-06-09 +
// `markdown-dialect.md` §3.6.1), so every imported note carries a matchable
// (folder, title) identity and re-imports dedup exactly, with no content hash
// needed.
//
// That paragraph used to end by saying a truly title-less ("Untitled") note
// "is not reachable through this import path". **That is no longer true**, and
// the sixth source is what falsified it: a Myne vault source (myne-md/myne#464)
// can carry any number of untitled notes, and its filenames are note UUIDs, so
// the filename-as-title injection is turned off there rather than titling them
// `019…` hex. Untitled notes therefore ARE reachable now, in bulk, and they get
// the one key they can have, a hash of their body, in `decideMyneImport`
// below. The claim is corrected here rather than deleted because the reasoning
// it carried is still right for the five sources it was written about.

import { foldSegment, folderKey } from "../../dialect/folderPath";
import { locateFrontmatter } from "../../dialect/lezer/frontmatter";

/** Minimal existing-note shape for identity matching (folder + title + lifecycle). */
export interface ExistingNote {
  folder: string | null;
  /** FM `title:` as Myne persists it; `null` = Untitled (no matchable identity). */
  title: string | null;
  /** Value-strict RFC-3339 timestamp when trashed; `null` = live. Matches
   *  `TitleRecord.trashed`, so the engine (sub-feature 3) passes note records
   *  straight through with no `string|null → boolean` adapter to invert. */
  trashed: string | null;
  template: boolean;
}

/**
 * Case-fold + NFC identity key for a (folder, title) pair — the same fold the
 * daily-note resolver matches on (`folderKey` + `foldSegment(title)`). NUL-joined
 * so a folder/title boundary can't be forged by an adversarial title.
 */
export function noteIdentityKey(folder: string | null, title: string): string {
  return folderKey(folder) + "\u0000" + foldSegment(title);
}

/**
 * Identity set of the LIVE vault (non-trashed, non-template, titled notes).
 * Untitled notes are excluded — they have no matchable identity (see the
 * RESIDUAL note above). Built once per import run from the whole vault, so a hit
 * covers both prior-import notes and Myne-native notes.
 */
export function buildExistingIdentitySet(
  notes: readonly ExistingNote[],
): Set<string> {
  const set = new Set<string>();
  for (const n of notes) {
    if (n.trashed !== null || n.template || n.title === null) continue;
    set.add(noteIdentityKey(n.folder, n.title));
  }
  return set;
}

/**
 * Read-only existence predicate — never mutates. Does a live note already have
 * this (folder, title) identity?
 */
export function noteIdentityExists(
  existing: ReadonlySet<string>,
  folder: string | null,
  title: string,
): boolean {
  return existing.has(noteIdentityKey(folder, title));
}

/** The single global pre-import toggle: skip a duplicate (default), or import it as a copy. */
export type DuplicatePolicy = "skip" | "import-as-copy";

/** Skip is the default — non-destructive, idempotent re-import. */
export const DEFAULT_DUPLICATE_POLICY: DuplicatePolicy = "skip";

/** Per-file outcome just before `note_create`. There is no overwrite/update outcome. */
export type ImportDecision = "create" | "skip";

/**
 * Decide whether to create or skip a candidate import, TS-side before
 * `note_create` (SYNC-1). Pure + read-only: an existing note is never touched.
 * `import-as-copy` always creates (a second legal (folder, title) pair, byte-
 * identical content, no rename / no `(1)` suffix — any later disambiguation is
 * MYND-51's flag path, never originated here).
 */
export function decideImport(
  existing: ReadonlySet<string>,
  folder: string | null,
  title: string,
  policy: DuplicatePolicy,
): ImportDecision {
  if (policy === "import-as-copy") return "create";
  return noteIdentityExists(existing, folder, title) ? "skip" : "create";
}

/** Per-run tally feeding the shared summary DTO (SYNC-2). The engine (sub-feature
 *  3) maps `skippedExisting` to the DTO's "skipped (already exist)" field; this
 *  feature only populates the count, it does not redefine the DTO shape. */
export interface ImportDecisionTally {
  created: number;
  skippedExisting: number;
}

export function tallyDecisions(
  decisions: readonly ImportDecision[],
): ImportDecisionTally {
  let created = 0;
  let skippedExisting = 0;
  for (const d of decisions) {
    if (d === "skip") skippedExisting++;
    else created++;
  }
  return { created, skippedExisting };
}

// ── Myne-source conflict rules (myne-md/myne#464) ───────────────────────────
//
// The three rules above are enough for every source whose notes come from
// outside Myne. A Myne source breaks two assumptions they rest on, and each
// break is a decision recorded in the design session rather than an accident:
//
//  - `import-as-copy` does not rename. For the other sources that is harmless,
//    because a duplicate `(folder, title)` pair is legal and the two notes are
//    told apart by their content. For a Myne source it is not, because
//    resolution is TITLE-KEYED (`wikilink.md` §5.3): two live notes sharing a
//    title make every `[[Title]]` in the vault ambiguous, including links in the
//    TARGET's own pre-existing notes, which the import never touched.
//
//  - The default policy is `skip`, and skip is where the real hazard lives.
//    Skipping a colliding note means an imported `[[Beta]]` resolves to the
//    TARGET's Beta: a single hit, no ambiguity, no warning, and a different
//    note than the author meant.

/** Everything the Myne-source decision needs that a per-note call cannot carry. */
export interface MyneConflictContext {
  /** The target vault's live identity set, from {@link buildExistingIdentitySet}. */
  readonly existing: ReadonlySet<string>;
  /**
   * Folded title to the source notes that link to it, built from the SOURCE's
   * own graph before ingest. A title in this map is one an imported note points
   * at, which is what makes skipping it dangerous rather than merely lossy.
   */
  readonly inboundLinks: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * The user's label for this import, used as the rename suffix.
   *
   * A label rather than a counter, and the reason is idempotency: a counter
   * produces "Project (1)" then "Project (2)" on a second run, so a re-import
   * duplicates everything it renamed. A label is stable, so the renamed title is
   * re-derived identically and the SECOND identity check below finds it and
   * skips. The cost is stated where the label is entered: change the label and
   * the run is no longer idempotent with the previous one.
   */
  readonly importLabel: string;
}

/** One source note, as the decision sees it. */
export interface MyneCandidate {
  readonly folder: string | null;
  /** Frontmatter `title:`, or `null` for a genuinely untitled note. */
  readonly title: string | null;
  /**
   * A hash of the note's mapped body, used as the identity key for UNTITLED
   * notes only.
   *
   * `buildExistingIdentitySet` excludes untitled notes because they have no
   * matchable `(folder, title)`, and `conflict.ts` used to record that such a
   * note "is not reachable through this import path". A Myne source makes it
   * reachable in bulk: a source vault can hold any number of them. Without a
   * key they would be created unconditionally on every run, so a user re-running
   * an import would accumulate a fresh pile of Untitled notes each time with
   * nothing to stop it. The other sources need no such key, which is why this
   * is scoped to the class that has no alternative rather than made general.
   */
  readonly bodyHash: string;
}

export type MyneImportOutcome =
  | { readonly kind: "create"; readonly renamedTitle: string | null }
  | { readonly kind: "skip" };

/**
 * The rename applied to a colliding source note.
 *
 * Deterministic in both arguments, which is the whole property: the same title
 * and the same label produce the same result on every run, so the second
 * identity check can find it.
 */
export function renamedTitleFor(title: string, importLabel: string): string {
  const label = importLabel.trim();
  // An empty label would produce "Project ()", which is worse than the
  // collision it is trying to disambiguate. The UI prefills the source vault's
  // own name and the field is required, so this is the belt to that suspenders.
  return label.length === 0 ? title : `${title} (${label})`;
}

/**
 * The bytes an untitled note's identity is taken over: everything after the
 * frontmatter block.
 *
 * Frontmatter is excluded, and that is the load-bearing half. The two sides of
 * the comparison do not see the same frontmatter: the candidate side hashes the
 * MAPPED plaintext, which may have had a `folder:` line injected, while the
 * target side hashes what a previous run actually stored. Hashing the whole
 * note would make those differ for the same note and the dedup would silently
 * never fire, which is the failure this key exists to prevent. The body is the
 * part the import transforms do not touch.
 */
export function bodyForIdentity(markdown: string): string {
  const located = locateFrontmatter(markdown);
  return located === null ? markdown : markdown.slice(located.blockEnd);
}

/**
 * A stable, cheap identity for an untitled note's body.
 *
 * FNV-1a over the UTF-16 code units, not a cryptographic hash: this keys a
 * dedup set, it never leaves the process, and nothing downstream trusts it. A
 * collision costs one skipped duplicate, not a wrong note, because the folder
 * is part of the key alongside it.
 */
export function hashBodyForIdentity(markdown: string): string {
  const body = bodyForIdentity(markdown);
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The identity key for an untitled note. Namespaced so it can never collide
 * with a real `(folder, title)` key: `noteIdentityKey` NUL-joins a folder and a
 * folded title, and no folded title starts with this marker.
 */
export function untitledIdentityKey(
  folder: string | null,
  bodyHash: string,
): string {
  return `${folderKey(folder)}  untitled:${bodyHash}`;
}

/**
 * Decide what happens to one source note.
 *
 * The guarantee this buys, stated as one sentence because it is the point of
 * the whole rule: **an imported wikilink never resolves to a note that was not
 * imported with it.** A colliding source note that nothing imported links to is
 * still skipped, exactly as today, because nothing points at it and the target
 * already has a note by that name.
 *
 * What it does NOT cover, and the design session accepted as a residual: a link
 * that was ALREADY broken in the source can resolve to a pre-existing target
 * note after import. Namespacing does not prevent it, because §5.3 keys on the
 * title component alone and the folder segment is only a tiebreak among
 * multiple hits, so there is no spelling for "link to nothing". The import
 * report names every one.
 */
export function decideMyneImport(
  ctx: MyneConflictContext,
  candidate: MyneCandidate,
): MyneImportOutcome {
  // Untitled notes have no `(folder, title)` to collide on. Their key is their
  // body, so a re-import of an unchanged note dedups and an edited one arrives
  // as the new note it now is.
  if (candidate.title === null) {
    return ctx.existing.has(untitledIdentityKey(candidate.folder, candidate.bodyHash))
      ? { kind: "skip" }
      : { kind: "create", renamedTitle: null };
  }

  const folded = foldSegment(candidate.title);
  const collides = ctx.existing.has(
    noteIdentityKey(candidate.folder, candidate.title),
  );
  if (!collides) return { kind: "create", renamedTitle: null };

  // Colliding, and nothing imported links to it: the target already has a note
  // by this name and no imported link cares which one it is. Skip, as before.
  const linkedFrom = ctx.inboundLinks.get(folded);
  if (linkedFrom === undefined || linkedFrom.size === 0) return { kind: "skip" };

  // Colliding AND linked. Rename, so the link can be rewritten to point at the
  // note that came with it rather than at the target's own.
  const renamed = renamedTitleFor(candidate.title, ctx.importLabel);

  // The SECOND identity check, and the reason the suffix has to be
  // deterministic. On a re-import with the same label the renamed note is
  // already in the target, so this is the check that makes the whole run
  // idempotent rather than doubling every renamed note.
  return ctx.existing.has(noteIdentityKey(candidate.folder, renamed))
    ? { kind: "skip" }
    : { kind: "create", renamedTitle: renamed };
}

/**
 * Extend a target identity set with keys for its UNTITLED notes.
 *
 * Called with the same body hash the candidate side computes, so the two agree
 * by construction. Kept separate from {@link buildExistingIdentitySet} because
 * that function is shared with five sources that have no untitled class, and
 * hashing every untitled note in the target vault for their benefit would be
 * work nobody asked for.
 */
export function addUntitledIdentities(
  base: ReadonlySet<string>,
  untitled: readonly { folder: string | null; bodyHash: string }[],
): Set<string> {
  const set = new Set(base);
  for (const n of untitled) set.add(untitledIdentityKey(n.folder, n.bodyHash));
  return set;
}
