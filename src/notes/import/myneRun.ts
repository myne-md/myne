// Running a Myne vault import (myne-md/myne#464).
//
// A sibling of `runSourceImport` rather than a branch inside it, because almost
// nothing it does applies here: there is no picked tree, no `ImportPorts` over a
// directory, no media index and no path-based media importer. What IS shared is
// the part that matters — the engine loop, the sink, the identity snapshot, the
// import hold and the report — and those are called directly.

import { importFromSource } from "./engine";
import type { ImportResult } from "./engine";
import { loadIdentitySnapshot, withImportHold } from "./ports";
import { formatStamp } from "./report";
import { createMyneSource } from "./sources/myne";
import { carrySourceDictionary } from "./sources/myneDictionary";
import { addUntitledIdentities, type DuplicatePolicy } from "./conflict";
import type { ImportPorts } from "./source";

/** What a Myne import needs beyond the source vault's id. */
export interface MyneImportOptions {
  /**
   * The label the renamed notes are suffixed with, and the reason a repeat run
   * is idempotent. Prefilled from the source vault's own name on the setup step.
   */
  readonly importLabel: string;
  readonly onProgress?: (done: number, total: number) => void;
  readonly shouldCancel?: () => boolean;
}

/** The extra rows a Myne import contributes to the report. */
export interface MyneImportExtras {
  readonly trashedLeftBehind: number;
  readonly templatesLeftBehind: number;
  readonly untitledImported: number;
  readonly attachmentsCrossed: number;
  readonly attachmentsDeduped: number;
  readonly attachmentsFailed: number;
  readonly linksRetargeted: number;
  readonly tombstonedEmbeds: number;
  /** Links whose target did not cross. See `MyneRewriteTally`. */
  readonly linksLeftUnresolved: number;
  /** Source notes that would not decrypt. Counted, never fatal. */
  readonly unreadableNotes: number;
  readonly dictionaryWordsAdded: number;
  readonly dictionaryUnreadable: boolean;
}

export interface MyneImportOutcome {
  readonly result: ImportResult;
  readonly extras: MyneImportExtras;
}

/**
 * Import notes from another local Myne vault into the currently-open one.
 *
 * The source vault's import slot must already be open (the credential step calls
 * `importSourceOpen`). This function does NOT close it: the caller owns that,
 * because the caller also owns every other exit path (cancel, unmount, error)
 * and a close split across two owners is a close that gets skipped on one of
 * them.
 */
export async function runMyneVaultImport(
  sourceVaultId: string,
  policy: DuplicatePolicy,
  ports: ImportPorts,
  options: MyneImportOptions,
): Promise<MyneImportOutcome> {
  // The identity snapshot is the TITLED half plus the UNTITLED half, and the
  // second half is not optional here. `buildExistingIdentitySet` skips untitled
  // notes because they have no matchable `(folder, title)`, which is right for
  // every source whose notes come from outside Myne. A Myne source carries
  // untitled notes in bulk, and without their body-hash keys in the set the
  // untitled branch of `decideMyneImport` can only ever answer `create`: a
  // second import of the same vault would duplicate every untitled note, which
  // is exactly what that branch exists to prevent.
  //
  // ONE snapshot call, not two loaders in a `Promise.all`. Both halves derive
  // from the same `noteList()` + `loadNoteBatch()`, so running them as siblings
  // decrypted every note in the target twice, concurrently, before the import
  // had read anything from the source.
  const { titled, untitled } = await loadIdentitySnapshot();
  const existingIdentity = addUntitledIdentities(titled, untitled);
  // The adapter assembles its own conflict context around the link graph
  // `plan()` builds, so only the two things it cannot know are passed in.
  const adapter = createMyneSource(sourceVaultId, {
    existing: existingIdentity,
    importLabel: options.importLabel,
  });

  const result = await withImportHold(ports, () =>
    importFromSource(adapter, ports, existingIdentity, policy, {
      onProgress: options.onProgress,
      shouldCancel: options.shouldCancel,
      // No path-based media importer: a Myne source's attachments are already
      // encrypted blobs and cross through the host-side re-seal instead.
      importMedia: undefined,
    }),
  );

  // A run that did not FINISH stops here, before the dictionary and before the
  // report. Both halves of that matter and neither is cosmetic.
  //
  // The dictionary carry is a durable, SYNCED write into the target's
  // `vault.dictionary`. It is the one non-additive effect of this whole flow,
  // and running it after the user pressed Cancel means the cancel did not
  // cancel: the words are in, they sync, and nothing on screen said so. A note
  // that already landed is different, and stays, because SYNC-6 says a
  // cancelled import keeps its partial result rather than rolling back.
  //
  // The report is skipped for a different reason: its counts come from `plan()`
  // rather than from what the loop created, so on a cancelled run every row is
  // about the whole source instead of the prefix that ran.
  // `trashedLeftBehind` and `templatesLeftBehind` describe notes the run never
  // reached, and `untitledImported` counts untitled notes in the SOURCE, under
  // a row that says they were brought over. A durable note asserting numbers
  // that describe a run that did not happen is worse than no note.
  //
  // `stopped` is included with `cancelled`: a write failure stops the loop the
  // same way, and the same two arguments apply to it unchanged.
  if (result.cancelled !== null || result.stopped !== null) {
    return {
      result,
      extras: {
        ...zeroExtras(),
        // The one count that IS about what happened rather than about the
        // source, so it survives: the rewrite tallies are incremented per note
        // as the loop runs.
        attachmentsCrossed: adapter.tally.attachmentsCrossed,
        attachmentsDeduped: adapter.tally.attachmentsDeduped,
        attachmentsFailed: adapter.tally.attachmentsFailed,
        linksRetargeted: adapter.tally.linksRetargeted,
        tombstonedEmbeds: adapter.tally.tombstonedEmbeds,
        linksLeftUnresolved: adapter.tally.linksLeftUnresolved,
      },
    };
  }

  // The dictionary is carried AFTER the notes, and its failure is never fatal:
  // the notes are already in, so refusing to finish because a dictionary would
  // not decrypt would report failure for an import that succeeded.
  const dictionary = await carrySourceDictionary(sourceVaultId);

  // The report note, and it is built HERE rather than through
  // `buildImportReport`.
  //
  // That function triggers on `lossyNotes`, which is the right trigger for
  // every other source: they lose CONSTRUCTS, per note, and the report lists
  // which. A Myne source loses no constructs at all (the two vaults speak the
  // same dialect), so `lossyNotes` is always empty and `buildImportReport`
  // always returns `null`. Routing through it would have left this import with
  // no durable record at all: every fact about what did not cross would exist
  // only in a modal the user dismisses.
  //
  // What it reports instead is the not-crossed set, which is the thing a user
  // has to be able to go back and read.
  const extras: MyneImportExtras = {
    trashedLeftBehind: adapter.summary.trashed,
    templatesLeftBehind: adapter.summary.templates,
    untitledImported: adapter.summary.untitled,
    attachmentsCrossed: adapter.tally.attachmentsCrossed,
    attachmentsDeduped: adapter.tally.attachmentsDeduped,
    attachmentsFailed: adapter.tally.attachmentsFailed,
    linksRetargeted: adapter.tally.linksRetargeted,
    tombstonedEmbeds: adapter.tally.tombstonedEmbeds,
    linksLeftUnresolved: adapter.tally.linksLeftUnresolved,
    unreadableNotes: adapter.summary.unreadable,
    dictionaryWordsAdded: dictionary.added,
    dictionaryUnreadable: dictionary.unreadable,
  };

  const report = buildMyneImportReport(
    result,
    extras,
    formatStamp(new Date()),
  );
  if (report !== null) {
    try {
      await ports.createNote(report);
    } catch {
      // Same guard the other sources use: the report is written after every
      // note has landed, so failing the import here would report failure for an
      // import that fully succeeded.
    }
  }

  return { result, extras };
}

/**
 * The extras a run that did not finish reports: everything the source-wide
 * counts would have claimed, zeroed.
 *
 * Zeroed rather than omitted, because `MyneImportExtras` is what the summary
 * renders and a missing field would render as a blank row rather than as an
 * absent one. The caller then puts back the per-note tallies, which are the
 * only counts that describe the prefix that actually ran.
 */
function zeroExtras(): MyneImportExtras {
  return {
    trashedLeftBehind: 0,
    templatesLeftBehind: 0,
    untitledImported: 0,
    attachmentsCrossed: 0,
    attachmentsDeduped: 0,
    attachmentsFailed: 0,
    linksRetargeted: 0,
    tombstonedEmbeds: 0,
    linksLeftUnresolved: 0,
    unreadableNotes: 0,
    dictionaryWordsAdded: 0,
    dictionaryUnreadable: false,
  };
}

/**
 * The durable record of one vault import.
 *
 * Returns `null` only when there is genuinely nothing to say: everything
 * crossed and nothing was left behind. Any non-zero not-crossed count is worth
 * a note, because the alternative is that the only place those numbers ever
 * appeared was a modal the user closed.
 */
export function buildMyneImportReport(
  result: ImportResult,
  extras: MyneImportExtras,
  stamp: string,
): string | null {
  const leftBehind =
    extras.trashedLeftBehind +
    extras.templatesLeftBehind +
    extras.attachmentsFailed +
    extras.tombstonedEmbeds +
    extras.linksLeftUnresolved +
    extras.unreadableNotes +
    result.skippedExisting;
  if (leftBehind === 0 && extras.linksRetargeted === 0) return null;

  const title = `Import report ${stamp}`;
  const rows: string[] = [];
  const row = (label: string, n: number): void => {
    if (n > 0) rows.push(`- ${label}: ${n}`);
  };
  row("Notes skipped because you already had one by that name", result.skippedExisting);
  row("Links pointed at a note that was renamed on the way in", extras.linksRetargeted);
  row("Notes left in the source vault's trash", extras.trashedLeftBehind);
  row("Templates left in the source vault", extras.templatesLeftBehind);
  row("Attachments this vault would not accept", extras.attachmentsFailed);
  row("Embeds whose file was already deleted in the source", extras.tombstonedEmbeds);
  // The residual myne-md/myne#464 calls the highest-risk behaviour in the
  // feature, and its own words on it are "Silent is not an option". The row is
  // deliberately last of the not-crossed rows and deliberately says what the
  // user should DO, because unlike every other row it names something that is
  // now sitting inside their notes rather than something that stayed behind.
  row(
    "Links pointing at a note that did not come across (they will not open until you make one)",
    extras.linksLeftUnresolved,
  );
  row("Notes in the source vault that could not be read", extras.unreadableNotes);

  return [
    "---",
    `title: ${title}`,
    "---",
    "",
    `# ${title}`,
    "",
    `Myne imported ${result.imported} ${result.imported === 1 ? "note" : "notes"} from ` +
      "another Myne vault. This note records what did not come across, so you can " +
      "check it later rather than having to remember the summary screen.",
    "",
    ...rows,
    "",
    "Version history, deleted notes and templates stay in the vault you imported " +
      "from, and so does any file in its attachment library that no note used. " +
      "That vault has not been changed, and if you sync it, it keeps syncing.",
    ...(extras.dictionaryUnreadable
      ? [
          "",
          "The source vault's dictionary could not be read, so no added words came " +
            "across.",
        ]
      : []),
    "",
  ].join("\n");
}
