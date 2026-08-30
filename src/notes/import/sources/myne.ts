// The Myne vault import source (myne-md/myne#464).
//
// The sixth adapter, and the only one whose source is ENCRYPTED. Every other
// adapter reads plaintext files the user picked; this one reads another Myne
// vault through a read-only key slot the host holds for the length of the run.
//
// Two shape decisions follow from that and are worth stating, because neither is
// obvious from the seam:
//
// 1. `plan()` reads every source note ONCE and keeps none of the bodies. It has
//    to read them: the linked-note rule (task 5) needs the source's OWN wikilink
//    graph before ingest, and a note's links are inside its body. What it keeps
//    is titles, folders, lifecycle flags, link targets and attachment ids, all
//    small. `load()` then reads the body again, one at a time. Two decrypts per
//    note, one body in RAM at any moment, which is the engine's D3 rule intact.
//
// 2. `titleFromFilename` is `false`. A Myne vault's filenames are note UUIDs, so
//    the filename-as-title injection every other source relies on would title an
//    untitled note `019…` hex. They stay Untitled, as they are in the source.

import { parse } from "../../../dialect/parse";
import { foldSegment, isFolderTarget } from "../../../dialect/folderPath";
import {
  readTemplateFromFmBody,
  readTrashedFromFmBody,
} from "../../../dialect";
import {
  importSourceListNotes,
  importSourceReadNote,
  importSourceResealAttachment,
} from "../../../lib/import-source-vault";
import {
  decideMyneImport,
  hashBodyForIdentity,
  noteIdentityKey,
  renamedTitleFor,
  untitledIdentityKey,
  type MyneConflictContext,
} from "../conflict";
import { rewriteMyneBody } from "./myneRewrite";
import { emptyIgnoreCounts } from "../skipPredicate";
import type { ImportPlan, ImportSource, LoadedItem } from "../source";

/** One source note, as `plan()` saw it. Bodies are deliberately absent. */
export interface MyneSourceNote {
  readonly noteId: string;
  /** Frontmatter `title:`, or `null` for a genuinely untitled note. */
  readonly title: string | null;
  /** Frontmatter `folder:`, or `null` for a root note. */
  readonly folder: string | null;
  /**
   * Folded titles this note links to, non-embed wikilinks only. Folded with the
   * SAME fold the resolver and the importer's identity key use, so a lookup
   * here and a lookup there cannot disagree.
   */
  readonly linkTargets: ReadonlySet<string>;
  /** Attachment ids this note embeds, from `![[att:<id>|…]]` forms. */
  readonly attachmentIds: ReadonlySet<string>;
}

/** What the source left behind, for the import report. */
export interface MyneSourceSummary {
  /** Notes in the source's trash. Deletions are not carried forward. */
  readonly trashed: number;
  /** Templates. Not carried; their conflict behaviour is undefined by design. */
  readonly templates: number;
  /** Source notes with no frontmatter `title:`. These DO cross, untitled. */
  readonly untitled: number;
  /**
   * Source notes that would not decrypt, and so contributed neither a note nor
   * a link nor an attachment.
   *
   * Counted rather than thrown, and the difference is task 2's acceptance
   * criterion: "one damaged note in the source cannot make the source
   * unimportable". A throw here aborted `plan()` before a single note had been
   * looked at, so one bad blob in a thousand-note vault imported nothing and
   * said only that a read failed.
   */
  readonly unreadable: number;
}

/**
 * The adapter, plus the two tallies the report reads once the run is over.
 *
 * The plan itself and the source's link graph stay INSIDE the closure. They are
 * the adapter's working state, read by its own `policy`, and exposing them would
 * invite a caller to reach past the seam into a map whose lifetime is one run.
 */
export interface MyneImportSource extends ImportSource {
  readonly summary: MyneSourceSummary;
  /** Rewrite + attachment totals, read by the report once the run is over. */
  readonly tally: MyneRewriteTally;
}

/** `![[att:<id>|filename]]` — the attachment-embed wikilink form (form 12). */
const ATTACHMENT_TARGET = /^att:([0-9a-f]{64})$/;

/**
 * The relative path the engine sees for a source note.
 *
 * Its FOLDER half is load-bearing and its basename half is not. `mapImportedFile`
 * derives the note's folder from this path, and `deriveImportFolder` is what
 * decides where the note lands when the note carries no `folder:` of its own. The
 * basename would normally become the title, but this source turns that injection
 * off (`titleFromFilename: false`), so nothing downstream reads it as a name.
 *
 * **The basename is the note's UUID, never its title.** An earlier version used
 * the title, which looked friendlier and silently lost notes: `planned` is keyed
 * by this path, and two source notes sharing a `(folder, title)` pair are LEGAL
 * in Myne (`conflict.ts` says so outright), so the second one overwrote the first
 * in the map. It then never appeared in the plan, never imported, and was counted
 * nowhere. The id is the only basename that is unique by construction.
 */
function relPathFor(note: { noteId: string; folder: string | null }): string {
  return note.folder === null
    ? `${note.noteId}.md`
    : `${note.folder}/${note.noteId}.md`;
}

/**
 * Links in one note whose target is not among the titles that crossed.
 *
 * Counted per LINK rather than per note, which is what makes the report's
 * number mean what its row says. A note carrying three dangling links
 * contributes three.
 */
function countUnresolved(
  targets: ReadonlySet<string> | undefined,
  crossing: ReadonlySet<string>,
): number {
  if (targets === undefined) return 0;
  let n = 0;
  for (const t of targets) if (!crossing.has(t)) n += 1;
  return n;
}

/**
 * Whether a read failure means the import slot is gone rather than one note
 * being damaged.
 *
 * Keyed on the serde tag `ImportSourceReadError` carries (`#[serde(tag =
 * "kind")]`), not on message text: the message is user-facing copy and is
 * translated, so matching it would make the distinction locale-dependent and
 * silently wrong in 30 of 31 languages.
 *
 * `SessionClosed` is the ONE variant that must not be swallowed, and the enum
 * itself says why: it means the slot was closed, expired, or the vault locked
 * underneath the import. All three apply to every remaining note, so counting
 * them as damaged notes would report a thousand unreadable notes for one
 * expired slot and then write a report saying the source vault was corrupt.
 * `CannotDecrypt`, `NoteNotFound` and `Io` really are per note.
 */
function isSessionGone(e: unknown): boolean {
  const kind = (e as { kind?: unknown } | null)?.kind;
  return kind === "SessionClosed";
}

function readString(
  fm: Record<string, unknown> | null,
  key: string,
): string | null {
  const v = fm?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * An `ImportSource` over another LOCAL Myne vault.
 *
 * `sourceVaultId` must already have an open import slot: the caller opens it
 * with `importSourceOpen` on the credential step and closes it on every exit
 * path. Every command here refuses with `SessionClosed` once it is gone, which
 * is also what a TTL expiry or a target-vault lock looks like from here.
 */
/** Running totals the report reads once the run is over. */
export interface MyneRewriteTally {
  attachmentsCrossed: number;
  attachmentsDeduped: number;
  attachmentsFailed: number;
  linksRetargeted: number;
  tombstonedEmbeds: number;
  /**
   * Wikilinks in the imported notes whose target did not come across.
   *
   * The residual of the linked-note rule, and the thing `conflict.ts` and
   * `docs/decisions/storage/0544` both claimed was reported per link while
   * nothing computed it. A link is in this count when its folded target is not
   * the title of any note that crossed: the target was trashed, was a template,
   * was untitled (so it has no title to resolve BY), or would not decrypt.
   *
   * Two different outcomes hide behind it and the count deliberately does not
   * split them, because only one is decidable from the source: the link
   * resolves to nothing, or it silently binds to a note the TARGET vault
   * already had under that name. Distinguishing them needs the target's
   * title-keyed index rather than its `(folder, title)` identity set, and a
   * count that claimed the distinction without it would be a guess. What the
   * user needs is the same either way, which is to be told the links exist.
   */
  linksLeftUnresolved: number;
}

/** What the caller knows that the adapter cannot read for itself. */
export interface MyneSourceConflictInput {
  /**
   * The TARGET vault's live identity set. Supplied rather than read here
   * because the adapter's whole world is the source: it has no business
   * enumerating the vault being imported INTO.
   */
  readonly existing: ReadonlySet<string>;
  /** The rename suffix, and the reason a repeat run is idempotent. */
  readonly importLabel: string;
}

export function createMyneSource(
  sourceVaultId: string,
  conflictInput: MyneSourceConflictInput,
): MyneImportSource {
  const planned = new Map<string, MyneSourceNote>();
  const inboundLinks = new Map<string, Set<string>>();
  let summary: MyneSourceSummary = {
    trashed: 0,
    templates: 0,
    untitled: 0,
    unreadable: 0,
  };
  /** Folded titles of the notes that will cross. See `plan()`. */
  const crossingTitles = new Set<string>();
  const tally: MyneRewriteTally = {
    attachmentsCrossed: 0,
    attachmentsDeduped: 0,
    attachmentsFailed: 0,
    linksRetargeted: 0,
    tombstonedEmbeds: 0,
    linksLeftUnresolved: 0,
  };
  /** Source attachment id to the id it got in the target, once re-sealed. */
  const resealed = new Map<string, string>();
  /**
   * Attachment ids the TARGET refused, so the rewrite does not also count them
   * as source-side tombstones. Both leave the embed pointing at a source id, so
   * the body is identical and only the cause differs.
   */
  const refused = new Set<string>();
  /** Folded OLD title to the NEW title, accumulated as notes are decided. */
  const renamedTitles = new Map<string, string>();
  /**
   * The conflict context, assembled HERE rather than taken as a parameter.
   *
   * It holds the adapter's own `inboundLinks` map by reference, which is the
   * whole point: `plan()` fills that map, and the linked-note rule reads it
   * during ingest. Taking a ready-made context from the caller would mean the
   * caller passing a map it cannot fill, and the rule would silently never
   * fire because the map it consulted stayed empty.
   */
  const conflict: MyneConflictContext = {
    existing: conflictInput.existing,
    // The SAME set, and that is correct here: `conflictInput.existing` IS the
    // pre-run snapshot, taken by `runMyneVaultImport` before the loop. The
    // `existing` field is overridden per item below with the engine's live set;
    // `preRun` is never overridden, which is what makes the two differ.
    preRun: conflictInput.existing,
    inboundLinks,
    importLabel: conflictInput.importLabel,
  };
  /**
   * Untitled identities created during THIS run.
   *
   * `conflict.existing` is a snapshot of the target taken before the run, so it
   * cannot see a note the run itself just created. Titled notes do not need this
   * because the engine keeps its own `seen` set for them; untitled ones are
   * keyed by body hash, which the engine knows nothing about.
   */
  const seenUntitled = new Set<string>();

  return {
    id: "myne",
    // See the module header: a Myne vault's filenames are note UUIDs.
    titleFromFilename: false,
    get summary() {
      return summary;
    },
    get tally() {
      return tally;
    },

    policy: {
      decide(candidate) {
        // Exact lookup by the key `plan()` produced. Matching on the title
        // instead would pick the wrong note for every untitled one, because the
        // engine's derived title for those is the note's UUID filename.
        const note = planned.get(candidate.relPath);
        const title = note?.title ?? null;
        const bodyHash = hashBodyForIdentity(candidate.markdown);

        // The run-local half of the identity set. `conflict.existing` is built
        // once BEFORE the run, so without this two identical untitled notes in
        // the SAME import would both be created: neither is in the target when
        // the run starts, and nothing else would notice the second one.
        if (title === null && seenUntitled.has(untitledIdentityKey(candidate.folder, bodyHash))) {
          return { kind: "skip" };
        }

        // The engine's LIVE set, not the pre-run snapshot: a note created
        // earlier in this run has to be visible to this decision.
        const outcome = decideMyneImport(
          { ...conflict, existing: candidate.seen },
          { folder: candidate.folder, title, bodyHash },
        );
        if (outcome.kind === "create" && title === null) {
          seenUntitled.add(untitledIdentityKey(candidate.folder, bodyHash));
        }
        // No rename is recorded here, and the map really is complete rather
        // than merely filled early.
        //
        // `plan()` computes a rename for every note that collides with the
        // PRE-RUN snapshot and is linked to, and `decideMyneImport` now emits
        // `renamedTitle` from that same condition and no other: a collision
        // with a note this run created is a legal source-side duplicate and
        // takes the create arm unrenamed. So the two agree by construction.
        //
        // Before that change they did not. `decide` evaluated collisions
        // against the engine's LIVE set, so a run-local collision produced a
        // `renamedTitle` with no entry in `renamedTitles`, and no inbound link
        // was ever retargeted to it. This comment asserted the property; the
        // code now has it.
        return outcome;
      },

      async finalize(markdown, ctx) {
        // Re-seal the attachments THIS note references, and only now: `load()`
        // does not yet know whether the note survives the duplicate decision,
        // and re-sealing for a note that gets skipped would write blobs nothing
        // references. The item is looked up from the ctx rather than remembered
        // between the two calls, so the two hooks share no mutable state.
        const ids = planned.get(ctx.relPath)?.attachmentIds ?? new Set<string>();
        for (const id of ids) {
          if (resealed.has(id)) continue;
          try {
            const out = await importSourceResealAttachment(sourceVaultId, id);
            resealed.set(id, out.target_id);
            if (out.deduplicated) tally.attachmentsDeduped += 1;
            else tally.attachmentsCrossed += 1;
          } catch {
            // A refused attachment is REPORTED, not fatal. The embed is left
            // pointing at the source id, so it renders as a tombstone in the
            // target: the note still arrives, and the report says what did not.
            tally.attachmentsFailed += 1;
            // And it is recorded so the rewrite does not count it a SECOND
            // time. `rewriteMyneBody` tallies any embed whose id is missing
            // from the re-seal map as `tombstonedEmbeds`, whose report row
            // reads "already deleted in the source vault" — which is a
            // different fact and, for this embed, a false one. One cause, one
            // row.
            refused.add(id);
          }
        }

        const out = rewriteMyneBody(markdown, {
          attachmentIds: resealed,
          renamedTitles,
          refusedAttachmentIds: refused,
        });
        tally.linksRetargeted += out.linksRetargeted;
        tally.tombstonedEmbeds += out.tombstonedEmbeds;
        tally.linksLeftUnresolved += countUnresolved(
          planned.get(ctx.relPath)?.linkTargets,
          crossingTitles,
        );
        return out.markdown;
      },
    },

    async plan(): Promise<ImportPlan> {
      const ids = await importSourceListNotes(sourceVaultId);

      let trashed = 0;
      let templates = 0;
      let untitled = 0;
      let unreadable = 0;
      const notes: MyneSourceNote[] = [];

      for (const noteId of ids) {
        // One decrypt, one parse, and the body is dropped at the end of this
        // iteration. Holding them all would be the D3 violation.
        //
        // A note that will not decrypt is COUNTED and skipped, never thrown.
        // Task 2's acceptance criterion is that one damaged note cannot make
        // the source unimportable, and a throw here aborts before the first
        // note has been looked at. The one failure this does NOT swallow is the
        // session being gone (a TTL expiry, a target-vault lock, a wrong
        // vault): that is not a damaged note, it applies to every remaining
        // read, and continuing would report a thousand unreadable notes for one
        // expired slot.
        let markdown: string;
        try {
          markdown = await importSourceReadNote(sourceVaultId, noteId);
        } catch (e) {
          if (isSessionGone(e)) throw e;
          unreadable += 1;
          continue;
        }
        const parsed = parse(markdown);
        const fm = parsed.frontmatter.parsed as Record<string, unknown> | null;
        const raw = parsed.frontmatter.raw ?? "";

        // The VALUE-STRICT readers, not the js-yaml map. `trashed:` is an
        // RFC-3339 timestamp and `template:` is a literal `true`, and reading
        // them off the parsed map treats `trashed: false` or `trashed: hello`
        // as trashed. That is not a cosmetic difference here: a note whose
        // frontmatter carries any truthy-looking `trashed` value would be
        // silently left behind and counted as deleted. `loadNoteBatch` reads
        // them this way for the same reason and says so.
        const isTrashed = readTrashedFromFmBody(raw) !== null;
        const isTemplate = readTemplateFromFmBody(raw);
        if (isTrashed) {
          trashed += 1;
          continue;
        }
        if (isTemplate) {
          templates += 1;
          continue;
        }

        const title = readString(fm, "title");
        if (title === null) untitled += 1;

        const linkTargets = new Set<string>();
        const attachmentIds = new Set<string>();
        for (const link of parsed.wikilinks) {
          // The ATTACHMENT branch stays first: an `![[att:<id>]]` is an
          // attachment reference, not a note link, and folding its id as a
          // title would put a 64-hex string in the link graph.
          const att = ATTACHMENT_TARGET.exec(link.target);
          if (att !== null) {
            attachmentIds.add(att[1]);
            continue;
          }
          // A NOTE embed is an inbound link, and skipping it was the defect.
          //
          // `if (link.embed) continue;` used to sit here, which excluded
          // `![[Beta]]` from `inboundLinks` while `myneRewrite.ts` retargets it
          // like any other link (its own test says why: a note embed resolves
          // title-keyed exactly as a link does). So a source note whose ONLY
          // reference to Beta was an embed did not make Beta "linked", the
          // rename rule did not fire, Beta took the skip arm, and the embed
          // silently rendered the TARGET's own Beta. That is verbatim the
          // hazard `decisions/storage/0544` names, and `countUnresolved` reads
          // the same set, so the report could not flag it either.
          //
          // A FOLDER target is skipped instead, and for a different reason:
          // `[[Projects/]]` addresses a folder, has no title to resolve, and
          // its final path segment is the empty string, which is in no set. It
          // was inflating `linksLeftUnresolved`, the row 0544 calls the
          // feature's highest-risk residual, with noise on any vault that uses
          // folder links.
          if (isFolderTarget(link.target)) continue;
          // Resolution is title-keyed (`wikilink.md` §5.3), so the FOLDER
          // segment of a path-form link is a disambiguator and the final
          // segment is the key. Fold it the way the resolver does.
          const finalSegment = link.target.split("/").pop() ?? link.target;
          if (finalSegment === "") continue;
          linkTargets.add(foldSegment(finalSegment.replace(/\.md$/i, "")));
        }

        notes.push({
          noteId,
          title,
          folder: readString(fm, "folder"),
          linkTargets,
          attachmentIds,
        });
      }

      // The inbound-link graph is built from the notes that will ACTUALLY be
      // imported. A link from a trashed source note is not a reason to carry
      // its target forward, since the note holding it is not crossing either.
      for (const note of notes) {
        for (const target of note.linkTargets) {
          const set = inboundLinks.get(target) ?? new Set<string>();
          set.add(note.noteId);
          inboundLinks.set(target, set);
        }
      }

      planned.clear();
      for (const note of notes) planned.set(relPathFor(note), note);
      summary = { trashed, templates, untitled, unreadable };

      // The titles that WILL exist in the target once this run finishes, folded
      // the way the resolver folds them. A link whose target is not in here
      // cannot be made to resolve by anything the import does, which is what
      // makes it the residual rather than a rewrite that has not happened yet.
      //
      // Untitled notes contribute nothing: they cross, but a note with no title
      // is not reachable by a title-keyed wikilink either before or after.
      crossingTitles.clear();
      for (const note of notes) {
        if (note.title !== null) crossingTitles.add(foldSegment(note.title));
      }

      // Every rename is decided HERE, before the ingest loop starts, and that
      // ordering is load-bearing rather than tidy.
      //
      // The renames used to be discovered one item at a time, in `decide`, and
      // consumed one item at a time, in `finalize`, within the same iteration.
      // So a note that came BEFORE the note it links to was finalized while the
      // map still had no entry for that rename, and its `[[Beta]]` went in
      // unrewritten, resolving to the TARGET's own Beta. That is exactly the
      // silent mis-link the rename rule exists to prevent, it was not reported
      // anywhere (`linksRetargeted` was simply lower), and plan order is
      // oldest-first, so an older note linking to a newer one is the ordinary
      // case rather than an edge one.
      //
      // `plan()` can decide them all because it already holds both inputs: the
      // target's pre-run identity set and the source's own link graph.
      renamedTitles.clear();
      for (const note of notes) {
        if (note.title === null) continue;
        const folded = foldSegment(note.title);
        const collides = conflictInput.existing.has(
          noteIdentityKey(note.folder, note.title),
        );
        const linked = (inboundLinks.get(folded)?.size ?? 0) > 0;
        if (!collides || !linked) continue;
        renamedTitles.set(
          note.title,
          renamedTitleFor(note.title, conflictInput.importLabel),
        );
      }

      return {
        items: [...planned.keys()].map((relPath) => ({ relPath })),
        // A Myne vault has no directory structure on disk: folders are virtual
        // and live in each note's `folder:` field, so there are no empty source
        // directories for SYNC-4 to carry across.
        dirs: [],
        ignore: emptyIgnoreCounts(),
        unfollowedLinks: [],
      };
    },

    async load(ref): Promise<LoadedItem> {
      const note = planned.get(ref.relPath);
      if (note === undefined) {
        // The engine only ever passes back a ref `plan()` produced, so this is
        // a caller bug rather than a vault that changed. Failing loudly beats
        // importing an empty note under a real title.
        throw new Error(`no planned Myne source note for ${ref.relPath}`);
      }
      const markdown = await importSourceReadNote(sourceVaultId, note.noteId);
      // Nothing is lossy on this path: the source and the target speak the same
      // dialect, so there is no construct to drop. The body rewrite (attachment
      // ids, renamed wikilinks) is a separate layer and does not belong here.
      return { markdown, lossy: [] };
    },
  };
}
