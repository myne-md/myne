// The note-selection predicates, shared by every client (#260).
//
// The audit that produced this file tested and DISPROVED the obvious worry:
// `@myne/dialect` and `@myne/editor` really are shared — all nine of mobile's
// `src/dialect/*` files are genuine re-export shims, there is no vendored copy,
// no second grammar and no second parser. Both clients read the same note text
// with the same code.
//
// What was never extracted is the layer ABOVE them: the predicates deciding
// WHICH notes reach those engines. Desktop kept them in `src/notes/sidebarState`
// and mobile re-implemented them as `useMemo`s in `EditorFlow.tsx`, so the two
// answers to "is this note part of the working set" drifted independently —
// four defects in that gap, plus a tail of fixes that landed on one client and
// never reached its twin. `98acbcc9` added the tombstone filter to the desktop
// trash list; mobile's Trash and Conflicts sheet never got it, so "Delete
// permanently" was a visible no-op and "Discard" never cleared a conflict.
//
// These are pure predicates over the record's own flags. The FOLDER-archive
// axis is deliberately not here: it needs the archived-folder key set, which is
// prefs state rather than a property of the note, and folding it in would make
// these functions take a second argument every caller would have to thread.
// `isNoteFolderArchived` stays where it is and composes with `isLiveNote`.
//
// `== null` (loose) throughout: a record constructed without the field must read
// as "not marked", which is the defensive direction — a missing `trashed` means
// live, never "unknown, so hide it".

/**
 * The subset of a note record these predicates read.
 *
 * Structural rather than an import of either client's record type, so neither
 * has to own the other's shape. Both `TitleRecord` (desktop) and mobile's row
 * type satisfy it.
 */
export interface NoteFlags {
  /** Value-strict `trashed:` marker, or `null` when the note is live. */
  trashed?: string | null;
  /** Value-strict `deleted:` tombstone, or `null`. */
  deleted?: string | null;
  /** Value-strict `archived:` marker, or `null`. */
  archived?: string | null;
  /** `true` when the note is a template. */
  template?: boolean;
  /** `true` when the note is a keep-both conflict copy. */
  conflict?: boolean;
}

/**
 * A tombstoned note (`deleted:`) — on disk only to PROPAGATE the deletion to
 * other devices and for server horizon-GC.
 *
 * It must be excluded from EVERY local view: sidebar, trash, conflicts, search,
 * resolver. This is the predicate mobile's Trash list was missing, which is why
 * "Delete permanently" appeared to do nothing — the tombstone it wrote was
 * still rendered as a trashed note.
 */
export function isTombstoned(record: NoteFlags): boolean {
  return record.deleted != null;
}

/** A keep-both conflict copy (MYND-427), pending reconciliation. */
export function isConflictCopy(record: NoteFlags): boolean {
  return record.conflict === true;
}

/** A template note — never part of the working set, whatever its other flags. */
export function isTemplateNote(record: NoteFlags): boolean {
  return record.template === true;
}

/** In the vault trash (and not already tombstoned). The Trash panel's view. */
export function isTrashedNote(record: NoteFlags): boolean {
  return record.trashed != null && record.deleted == null;
}

/** In the indefinite-retention Archive (and not trashed away underneath it). */
export function isArchivedNote(record: NoteFlags): boolean {
  return record.archived != null && record.trashed == null && record.deleted == null;
}

/**
 * Part of the WORKING SET — what the sidebar tree shows.
 *
 * Excludes trash, tombstones, archive, templates and conflict copies. Callers
 * that also honour folder-archive compose this with `isNoteFolderArchived`,
 * which needs the prefs-side key set.
 */
export function isLiveNote(record: NoteFlags): boolean {
  return (
    record.trashed == null &&
    record.deleted == null &&
    record.archived == null &&
    record.template !== true &&
    record.conflict !== true
  );
}

/**
 * Eligible to be a wikilink / backlink / graph TARGET.
 *
 * Wider than {@link isLiveNote} by exactly one axis: an ARCHIVED note is still
 * resolvable (archive is a working-set filter, not a deletion), which is why
 * the two predicates cannot be collapsed into one. Conflict copies are excluded
 * — a transient keep-both copy must not become a link target until reconciled.
 */
export function isResolverCandidate(record: NoteFlags): boolean {
  return (
    record.trashed == null &&
    record.deleted == null &&
    record.template !== true &&
    record.conflict !== true
  );
}

/** A template that is still listed (not trashed, not tombstoned). */
export function isListedTemplate(record: NoteFlags): boolean {
  return record.template === true && record.trashed == null && record.deleted == null;
}
