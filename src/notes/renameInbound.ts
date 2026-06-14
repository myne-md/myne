// Rename auto-update orchestrator (§8 / WL-7 / WL-8). When a note's title
// changes, every inbound `[[…]]` that resolved to it must be rewritten so the
// links don't break — and §8.3 requires the renamed note's own body PLUS all
// inbound rewrites to land **all-or-nothing** (a partial commit leaves an
// un-rewritten `[[Old Title]]` resolving to nothing). This module composes the
// already-tested pure pieces — `backlinks()` (inbound discovery, resolved
// against the PRE-rename note-set), `planInboundRewrites()` (form-preserving
// rewrite plan, §8.2), `partitionInbound()` (WL-8 open-dirty pre-flight gate,
// SYNC-15) — into the batch handed to `noteWriteBatchTransactional`.
//
// Pure + dependency-injected so it is unit-testable without React/Tauri: the
// real wiring (the `backlinks` IPC, `noteRead`, the workspace flush + open-note
// set) is supplied by `defaultRenameInboundDeps`; tests pass fakes.

import type { ResolverNote } from "./resolveWikilink";
import type { NoteBatchEntry } from "./noteWriteBatch";
import type { InboundRewrite } from "./renameWikilinks";
import { planInboundRewrites } from "./renameWikilinks";
import { partitionInbound, type InboundNote } from "./renamePreflight";
import { backlinks } from "./vaultIndices";
import { noteRead } from "./readNote";

/**
 * Apply a set of form-preserving inbound rewrites to a body string. The
 * planner's `byteRange` offsets are lezer/UTF-16 string positions (the field
 * name is a codebase-wide misnomer — `extractWikilinks` sets them from the
 * lezer parser's `node.from/to`, the same offsets `convert-command` feeds to
 * CodeMirror), so the splice is plain string slicing. Applying in descending
 * start order keeps earlier offsets valid as later ones are replaced. Pure; a
 * no-op for an empty rewrite list.
 */
export function applyInboundRewrites(
  body: string,
  rewrites: readonly InboundRewrite[],
): string {
  if (rewrites.length === 0) return body;
  const ordered = [...rewrites].sort(
    (a, b) => b.byteRange.start - a.byteRange.start,
  );
  let out = body;
  for (const r of ordered) {
    out = out.slice(0, r.byteRange.start) + r.after + out.slice(r.byteRange.end);
  }
  return out;
}

/** Injected I/O + workspace surface the orchestrator drives. */
export interface RenameInboundDeps {
  /** Inbound source note-ids for the renamed note, resolved against the
   *  PRE-rename note-set (so `[[Old Title]]` still resolves to it). */
  readonly findBacklinkSources: (
    renamedNoteId: string,
    preNotes: readonly ResolverNote[],
  ) => Promise<readonly string[]>;
  /** Read a note's current on-disk body (post-flush, so it is current). */
  readonly readBody: (noteId: string) => Promise<string>;
  /** The set of note-ids open in any pane right now (WL-8 input). */
  readonly openNoteIds: () => ReadonlySet<string>;
  /** Flush every dirty pane editor to disk (WL-8 pre-flight; SYNC-15). */
  readonly flushOpenPanes: () => Promise<void>;
}

export interface RenameBatchPlan {
  /** The all-or-nothing batch: the renamed note FIRST, then each inbound. */
  readonly batch: NoteBatchEntry[];
  /** Inbound note-ids actually rewritten (excludes the renamed note). */
  readonly inboundIds: string[];
}

export interface RenameBatchArgs {
  readonly renamedNoteId: string;
  /** The renamed note's title BEFORE the change (the key inbound links use).
   *  `null`/blank ⇒ nothing could link to it by title — inbound is empty. */
  readonly oldTitle: string | null;
  readonly newTitle: string;
  /** The renamed note's full new body (title surgery already applied). */
  readonly renamedNewBody: string;
  /** The resolver note-set as it was BEFORE the rename (renamed note still
   *  carries `oldTitle`) — drives inbound resolution. */
  readonly preNotes: readonly ResolverNote[];
}

/**
 * Compute the all-or-nothing rename batch: the renamed note's new body plus a
 * form-preserving rewrite of every inbound note. Runs the WL-8 open-dirty
 * pre-flight (flush before reading disk) so an open+dirty inbound note is
 * never disk-clobbered (SYNC-15). Does NOT write — the caller hands the
 * returned `batch` to `noteWriteBatchTransactional` so a write failure rolls
 * the whole set back.
 */
export async function planRenameBatch(
  deps: RenameInboundDeps,
  args: RenameBatchArgs,
): Promise<RenameBatchPlan> {
  const renamedEntry: NoteBatchEntry = {
    noteId: args.renamedNoteId,
    plaintext: args.renamedNewBody,
  };

  // An untitled-before rename has no inbound links to fix — just the note.
  if (args.oldTitle === null || args.oldTitle.trim() === "") {
    return { batch: [renamedEntry], inboundIds: [] };
  }
  // Bind to a non-null const so the narrowing survives into the async
  // `map` closure below (property narrowing is lost across a nested fn).
  const oldTitle = args.oldTitle;

  // 1. Inbound sources, resolved against the PRE-rename set. Drop a self-link
  //    (the renamed note's own body is `renamedNewBody`, handled above).
  const sources = (
    await deps.findBacklinkSources(args.renamedNoteId, args.preNotes)
  ).filter((id) => id !== args.renamedNoteId);

  // 2. WL-8 pre-flight (SYNC-15): if any inbound note is open (and so possibly
  //    holds unsaved edits the disk copy lacks), flush every pane first so the
  //    read below sees current content. `isDirty` is conservatively the
  //    open-ness — a clean open note's flush is a harmless no-op.
  const openIds = deps.openNoteIds();
  const inboundState: InboundNote[] = sources.map((noteId) => ({
    noteId,
    isOpen: openIds.has(noteId),
    isDirty: openIds.has(noteId),
  }));
  if (partitionInbound(inboundState).openDirty.length > 0) {
    await deps.flushOpenPanes();
  }

  // 3. Read each inbound note (now disk-current) + plan + apply the
  //    form-preserving rewrite. The reads are independent, so run them
  //    concurrently (order is preserved by `map`). Skip a source whose plan
  //    is empty (it resolved structurally but every ref is a no-op rebuild).
  const planned = await Promise.all(
    sources.map(async (noteId): Promise<NoteBatchEntry | null> => {
      const body = await deps.readBody(noteId);
      const rewrites = planInboundRewrites(body, {
        oldTitle,
        newTitle: args.newTitle,
      });
      if (rewrites.length === 0) return null;
      return { noteId, plaintext: applyInboundRewrites(body, rewrites) };
    }),
  );
  const inboundEntries = planned.filter(
    (e): e is NoteBatchEntry => e !== null,
  );

  return {
    batch: [renamedEntry, ...inboundEntries],
    inboundIds: inboundEntries.map((e) => e.noteId),
  };
}

/**
 * Production dependencies for {@link planRenameBatch}. `findBacklinkSources`
 * reuses the tested `backlinks()` (which resolves candidates against the
 * supplied note-set and excludes trashed sources); `openNoteIds`/`flushOpenPanes`
 * come from the workspace layer via the rename-flush registration seam
 * (`./renameFlushHook.ts`) since the sidebar provider sits ABOVE the workspace
 * provider and cannot read its context directly.
 */
export function defaultRenameInboundDeps(deps: {
  openNoteIds: () => ReadonlySet<string>;
  flushOpenPanes: () => Promise<void>;
}): RenameInboundDeps {
  return {
    findBacklinkSources: async (renamedNoteId, preNotes) =>
      (await backlinks(renamedNoteId, preNotes)).map((g) => g.sourceUuid),
    readBody: noteRead,
    openNoteIds: deps.openNoteIds,
    flushOpenPanes: deps.flushOpenPanes,
  };
}
