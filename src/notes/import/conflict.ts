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

import { foldSegment, folderKey, isLegalSegment } from "../../dialect/folderPath";
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
  /**
   * The LIVE identity set: the target's pre-run snapshot plus everything this
   * run has already created.
   */
  readonly existing: ReadonlySet<string>;
  /**
   * The target's identity set as it was BEFORE the run started.
   *
   * A second set rather than a flag, because the two collisions it separates
   * mean opposite things and the decision below answers them differently.
   *
   * A collision with THIS set is a real one: the user already had a note by
   * that name, and skipping it is the SYNC-5 idempotent behaviour the whole
   * rule exists for.
   *
   * A collision with `existing` ALONE means the colliding note is one this same
   * run created a moment ago, from a sibling source note. Two source notes
   * sharing a `(folder, title)` pair are LEGAL in Myne, which this file says
   * outright a few lines up, and `myne.ts` records that an earlier version of
   * `relPathFor` lost exactly those notes. Treating a run-local sibling as "you
   * already had one" lost them again one layer higher, and worse: they were
   * counted into `skippedExisting`, which the import report renders as notes
   * skipped because the user already had one by that name. The target had none.
   */
  readonly preRun: ReadonlySet<string>;
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
 * Whether an import label is safe to splice into a note title.
 *
 * The label is free text the user types, and `renamedTitleFor` splices it into
 * a string that becomes TWO things: the note's own frontmatter `title:`, and
 * the target of every retargeted wikilink. So the label inherits the dialect's
 * title-segment rule exactly, and the two characters that matter most are the
 * ones with no escape:
 *
 *   - a `/` makes `[[Beta (2024/archive)]]` a PATH-form link whose final
 *     segment is `archive)`, so every retargeted link resolves to nothing;
 *   - a `]]` closes the wikilink early and leaves the remainder as literal
 *     text in every note that linked to the renamed one, which is content
 *     corruption rather than a broken link.
 *
 * `isLegalSegment` is reused rather than re-listed, so this cannot drift from
 * the rule the parser enforces. It is applied to the RESULT rather than to the
 * label alone, because the length bound is on the whole title and a legal label
 * can still push a long title past it.
 *
 * `mapping.ts`'s illegal-segment check does not cover this: it runs on the
 * read-time title, before the rename, so no `illegalFlags` row is produced.
 */
export function isLegalImportLabel(title: string, importLabel: string): boolean {
  const label = importLabel.trim();
  if (label.length === 0) return false;
  return isLegalSegment(`${title} (${label})`);
}

/**
 * The rename applied to a colliding source note.
 *
 * Deterministic in both arguments, which is the whole property: the same title
 * and the same label produce the same result on every run, so the second
 * identity check can find it.
 *
 * Callers gate on {@link isLegalImportLabel} at the INPUT, which is where a
 * person can still fix it. This function is the last line rather than the
 * first: an illegal label reaching here returns the title unchanged, so the
 * rename becomes a no-op and the collision takes the skip arm, which is a
 * skipped note rather than a corrupted one.
 */
export function renamedTitleFor(title: string, importLabel: string): string {
  // The empty case is inside `isLegalImportLabel` now: an empty label would
  // produce "Project ()", which is worse than the collision it is trying to
  // disambiguate, and `isLegalSegment` would accept that string. The UI
  // prefills the source vault's own name and the field is required, so this is
  // the belt to that suspenders.
  if (!isLegalImportLabel(title, importLabel)) return title;
  return `${title} (${importLabel.trim()})`;
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
 * `[[target]]` / `![[target|alias]]` with the TARGET blanked and the alias kept.
 *
 * Deliberately a regular expression over the raw text rather than
 * `extractWikilinks`, and the difference is the point: this runs on both sides
 * of an identity comparison, on bodies that may sit in a code fence or not, and
 * a projection that treats the two contexts differently would make the two
 * sides disagree for a reason that has nothing to do with the note. Over-
 * matching here is safe, because the projection is only ever compared against
 * itself.
 */
const WIKILINK_FOR_IDENTITY = /(!?)\[\[([^\]\n]*?)(\|[^\]\n]*)?\]\]/g;

/**
 * The bytes an untitled note's identity is taken over, with the two things the
 * import rewrites removed.
 *
 * This is the fix for a defect that made untitled dedup silently never fire.
 * `decide()` hashes the body BEFORE `policy.finalize`, and the target side
 * hashes what was actually STORED, which is after it. Finalize rewrites exactly
 * two things: the id inside an `![[att:<id>|…]]` embed, which is an HMAC under
 * the holding vault's own `root_key` and therefore different in every vault,
 * and the target of a wikilink pointing at a note the run renamed. So any
 * untitled note containing an embed or a link to a renamed note hashed
 * differently on the two sides, dedup could not fire, and every re-import
 * created another copy and reported it as newly imported.
 * `decisions/storage/0544` states the dedup as a property; it was not one.
 *
 * The projection blanks the link TARGET and keeps the alias. Both halves are
 * load-bearing. Blanking the target is what makes the projection invariant
 * under the rewrite by construction rather than by luck, since the rewrite only
 * ever edits inside that span. Keeping the alias is what stops the projection
 * from over-merging: Myne's own picker emits `[[<path>.md|<Title>]]` and an
 * attachment embed carries its filename there, so two untitled notes embedding
 * different files stay distinguishable.
 *
 * What it costs, stated rather than left to be discovered: two untitled notes
 * in the same folder that differ ONLY in a link target, with identical aliases
 * and identical prose, hash the same, and the second is skipped. That is a note
 * that stays in the source vault rather than a note that is lost, and it is a
 * far smaller cost than unbounded duplication on every re-run.
 */
export function bodyProjectionForIdentity(markdown: string): string {
  return bodyForIdentity(markdown).replace(
    WIKILINK_FOR_IDENTITY,
    (_m, bang: string, _target: string, alias?: string) =>
      `${bang}[[${alias ?? ""}]]`,
  );
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
  const body = bodyProjectionForIdentity(markdown);
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
  // `\u0000`, matching `noteIdentityKey` above, and NOT the raw byte this
  // used to carry. The VALUE is identical either way; what the raw byte cost
  // was tooling: a literal NUL makes grep and ripgrep classify the file as
  // binary, so every grep-driven scan over `src/` silently read nothing from
  // the file that holds the import's whole identity-key namespace. Node-based
  // guards read with `fs` and were unaffected, which is what made it quiet.
  return folderKey(folder) + "\u0000\u0000untitled:" + bodyHash;
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
  const key = noteIdentityKey(candidate.folder, candidate.title);

  // Against the PRE-RUN snapshot, not the live set. See `preRun` above: a
  // collision with a note this same run created is a legal duplicate in the
  // SOURCE, and the source is allowed to hold two notes with one name.
  if (!ctx.preRun.has(key)) {
    // It may still collide with a sibling this run created. That is not a
    // reason to drop it, and it is deliberately not a reason to rename it
    // either: the two notes were ambiguous in the source under exactly this
    // name, and a link to that name was already ambiguous there. Renaming one
    // of them would invent a distinction the author never made, and the rename
    // suffix is the import's, not the note's.
    return { kind: "create", renamedTitle: null };
  }

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
  //
  // The LIVE set here, and the asymmetry with the check above is deliberate: a
  // renamed title is one this import minted, so a run-local hit on it means
  // this run already created that exact renamed note, which is a duplicate to
  // skip rather than a legal source-side pair to carry.
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
