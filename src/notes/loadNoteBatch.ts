// `loadNoteBatch` — chunked + parallel sidebar batch fetch.
//
// Per the 2026-05-15 MYND-82 grill Q3 (hybrid byte-range parse) +
// Q5 (hard cap 100 per call) + Q6 (parallel decrypt) +
// Q13 (initial-boot chunked Promise.all + action-driven surgical refresh):
//
//   1. Chunk inputs at `BATCH_CAP` so a caller passing the full
//      `note_list` output (potentially thousands of IDs in a future
//      large-vault scenario) doesn't trip the backend's
//      `BatchTooLarge { cap }` precondition.
//   2. Fire chunks in parallel via `Promise.all` — the backend
//      `note_titles_batch` already parallelizes per-ID decrypt inside
//      a single chunk; outer Promise.all stacks chunks concurrently
//      too. Wall-clock = max(chunk durations) ≈ ~10-30ms for typical
//      Phase 1 vaults.
//   3. Parse per-item title slices via `js-yaml` (frontmatter `title:`)
//      + first-H1-line strip; derive a `TitleRecord` per input ID.
//      Per-item backend failures (CannotDecrypt / NoteNotFound / Io)
//      surface as a `TitleRecord` with `title: null + error: <variant>`.
//
// Discipline rule: `noteUpdate` direct callers are forbidden (the
// `decisions.md` 2026-05-09 grep-greppable invariant); `loadNoteBatch`
// is the read-side analogue — direct `plugin:notes|note_titles_batch`
// callers outside this file are a contract violation.

import { invoke } from "../platform/core";
import { load as parseYaml } from "js-yaml";
import {
  readArchivedFromFmBody,
  readConflictFromFmBody,
  readConflictOfFromFmBody,
  readDeletedFromFmBody,
  readFolderIndexFromFmBody,
  readKindFromFmBody,
  readTemplateFromFmBody,
  readTitleFromFmBody,
  readTrashedFromFmBody,
} from "../dialect";
import { normalizeFolderPath } from "../dialect/folderPath";
import type {
  NoteTitleError,
  TitleSlice,
} from "../types/note-title-error";

/**
 * Per-call cap mirrored from the Rust constant `NOTE_TITLES_BATCH_CAP`
 * (`src-tauri/src/plugins/notes/commands.rs`). Bumping the value
 * requires updating both sides + the `BatchTooLarge { cap }` payload
 * documentation.
 */
export const NOTE_TITLES_BATCH_CAP = 100;

/**
 * Per-item shape returned by `loadNoteBatch`. Combines a derived
 * canonical title + `updated_at` Date, with an optional `error` field
 * carrying the per-item backend failure when the slice couldn't be
 * produced. Sidebar UI renders rows with `title === null` as the
 * "Untitled" italic placeholder (2026-05-15 MYND-82 grill Q2).
 */
export type TitleRecord = {
  noteUuid: string;
  title: string | null;
  /**
   * Canonical folder path (trailing-slash form) parsed from the frontmatter
   * `folder:` field, or `null` for a root / unfiled note. Consumed by the
   * sidebar folder-tree derivation (`deriveFolderTree`).
   */
  folder: string | null;
  updatedAt: Date | null;
  /**
   * Value-strict `trashed:` marker (RFC 3339 UTC string) when the note is in
   * the vault trash, else `null` (live). MYND-133. Consumers exclude
   * `trashed !== null` records from the live sidebar tree / folder derivation /
   * search; the Trash panel reads the complement. A user's own non-timestamp
   * `trashed:` value reads as `null` here (value-strict — `readTrashedFromFmBody`).
   */
  trashed: string | null;
  /**
   * Value-strict `deleted:` tombstone marker (RFC 3339 UTC string) when the note
   * has been deleted under sync (MYND-426), else `null`. Unlike `trashed:` (a
   * recoverable raft surfaced by the Trash panel), a `deleted !== null` record is
   * a tombstone: it lingers on disk only to PROPAGATE the deletion to other
   * devices (and for server horizon-GC), so it must be excluded from EVERY local
   * view — sidebar, trash, conflicts, search, resolver. Value-strict
   * (`readDeletedFromFmBody`); a user's own non-timestamp `deleted:` reads `null`.
   */
  deleted: string | null;
  /**
   * Value-strict `archived:` marker (RFC 3339 UTC string) when the note is in
   * the indefinite-retention Archive, else `null` (not archived). note-archive /
   * MYND-331. The value-strict twin of `trashed:`: a user's own non-timestamp
   * `archived:` value reads as `null` here (`readArchivedFromFmBody`). Archive
   * and trash are mutually exclusive — a note is at most one of `archived` /
   * `trashed`. Consumers exclude `archived !== null` records from the live
   * sidebar tree / folder derivation / favorites display, but — unlike trashed —
   * keep them in search results + backlink resolution (archive ≠ soft-trash).
   */
  archived: string | null;
  /**
   * Value-strict `template:` marker (MYND-186) — `true` iff the note carries the
   * canonical `template: true` flag, marking it a reusable template skeleton.
   * The inverse-visibility twin of `trashed:`: template records are excluded from
   * the live sidebar tree / folder derivation / search (like trashed notes) but
   * surfaced by the template picker + management UI (unlike trashed notes). A
   * note that is both `template:` and `trashed:` is in the Trash (restorable) and
   * absent from the template enumeration until restored. A user's own
   * non-canonical `template:` value reads as `false` (value-strict —
   * `readTemplateFromFmBody`).
   */
  template: boolean;
  /**
   * Value-strict `folder_index:` marker (MYND-370) — `true` iff the note carries
   * the canonical `folder_index: true` flag, designating it the **index note** of
   * whichever folder its own `folder:` field names. Unlike `trashed:`/`template:`,
   * this does NOT hide the note: the index note stays a visible, enumerable child
   * of its folder, pinned to the top by the folder-tree derivation. A user's own
   * non-canonical `folder_index:` value reads as `false` (value-strict —
   * `readFolderIndexFromFmBody`).
   */
  folderIndex: boolean;
  /**
   * Value-strict `conflict:` marker (MYND-427) — `true` iff the note is a sync
   * conflict copy (canonical `conflict: true`). Conflict copies are kept OUT of
   * the live sidebar/search (like trashed/template) and surfaced only in the
   * Conflicts view. A user's own non-canonical value reads `false`.
   */
  conflict: boolean;
  /**
   * The original note UUID a conflict copy forked from (`conflict_of:`), or
   * `null`. The Conflicts view groups copies by this value.
   */
  conflictOf: string | null;
  /**
   * `true` iff the note's frontmatter carries a top-level, **unmanaged**
   * `source:` provenance key (url-bookmark / SYNC-16) — the signal that the note
   * is a clipped link-only bookmark. Unlike the value-strict managed markers
   * above, this is mere *presence* detection: `source:` is a plain preserved
   * key the clipper writes (markdown-dialect §3.6, NOT promoted to the canonical
   * set), so any value counts. Drives the per-note tab glyph (`bookmark` instead
   * of `file-text`); carries no other display semantics.
   */
  hasSource: boolean;
  /**
   * Value-strict `kind:` marker (drawing-notes SF2, MYND-499) — `"drawing"` iff
   * the note carries the canonical `kind: drawing` flag (an Excalidraw canvas
   * note), else `null`. Read value-strict from the raw FM slice like
   * `template:`/`folder_index:` (`readKindFromFmBody`); a user's own
   * non-canonical `kind:` reads `null`, so a stray value never force-renders a
   * markdown note as a canvas. Drives the render-surface dispatch + tab/sidebar
   * glyph; unlike `trashed:`/`template:` it does NOT hide the note.
   */
  kind: "drawing" | null;
  error?: NoteTitleError;
};

/**
 * Tauri wire shape for `Result<T, E>`: `{"Ok": T}` or `{"Err": E}`.
 */
type ItemResult<T, E> = { Ok: T } | { Err: E };

/**
 * Thin IPC wrapper around the `note_titles_batch` Tauri command. Returns
 * the raw per-item Result array in input order; flattening / parsing
 * are caller-side concerns (`loadNoteBatch` orchestrates).
 *
 * **Internal — direct callers should prefer `loadNoteBatch`** which
 * handles chunking + parsing. Calling this directly with `> BATCH_CAP`
 * IDs rejects with `BatchTooLarge { cap }`.
 *
 * Rejects with a `NoteTitleBatchError` (see
 * `src/types/note-title-error.ts`) for batch-level preconditions.
 */
export async function noteTitlesBatch(
  ids: string[],
): Promise<Array<ItemResult<TitleSlice, NoteTitleError>>> {
  return await invoke<Array<ItemResult<TitleSlice, NoteTitleError>>>(
    "plugin:notes|note_titles_batch",
    { ids },
  );
}

function parseFrontmatterSlice(
  bytes: string | null,
): Record<string, unknown> {
  if (bytes === null || bytes.length === 0) return {};
  let loaded: unknown;
  try {
    loaded = parseYaml(bytes);
  } catch {
    // Malformed YAML → caller sees no title/updated, falls back to H1
    // or null. Matches the dialect's `parseFrontmatter` "yaml error →
    // parsed: null" behavior without rebuilding the full Frontmatter
    // shape here.
    return {};
  }
  if (loaded === null || loaded === undefined) return {};
  if (typeof loaded !== "object" || Array.isArray(loaded)) return {};
  return loaded as Record<string, unknown>;
}

function deriveUpdatedAt(parsed: Record<string, unknown>): Date | null {
  const raw = parsed["updated"];
  // js-yaml's default schema parses RFC 3339 / YAML 1.1 timestamps to
  // native `Date` instances. The string fallback covers cases where the
  // user wrote a quoted value or YAML couldn't infer the type.
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
}

function recordFromSlice(slice: TitleSlice): TitleRecord {
  const parsed = parseFrontmatterSlice(slice.frontmatter_bytes);
  // Title comes from the frontmatter `title:` key only — no first-H1
  // fallback. A note without an explicit `title:` renders as "Untitled"
  // until the user names it (sidebar rename / Properties title field).
  // js-yaml re-types an unquoted date-/int-/bool-shaped title to a non-string
  // (a daily note titled `2026-06-07` parses to a Date); fall back to the
  // value-strict raw read so the typed title still shows instead of "Untitled"
  // — heals notes written before the state-B title-quoting fix, plus imported
  // / hand-edited files. New Myne writes quote such titles (see surgery.ts).
  const titleRaw = parsed["title"];
  const titleFromFm =
    typeof titleRaw === "string"
      ? titleRaw
      : titleRaw === undefined || titleRaw === null
        ? null
        : readTitleFromFmBody(slice.frontmatter_bytes ?? "");
  // `folder:` → canonical trailing-slash path (or null = root/unfiled). Parse
  // is tolerant + non-mutating: imported / malformed paths are normalized
  // structurally only (no segment validation here).
  const folderRaw =
    typeof parsed["folder"] === "string" ? (parsed["folder"] as string) : null;
  // `trashed:` is read value-strict from the raw FM slice (NOT the js-yaml
  // object) so the sidebar path and the dialect `readTrashedField` share one
  // definition — js-yaml would coerce a date-only value to a Date and diverge.
  const trashed = readTrashedFromFmBody(slice.frontmatter_bytes ?? "");
  // `deleted:` sync tombstone (MYND-426) — value-strict, same RFC 3339 shape as
  // `trashed:`. A non-null value hides the note from every local view.
  const deleted = readDeletedFromFmBody(slice.frontmatter_bytes ?? "");
  // `archived:` read value-strict from the raw FM slice — same rationale and
  // RFC 3339 shape as `trashed:` (the value-strict timestamp twin).
  const archived = readArchivedFromFmBody(slice.frontmatter_bytes ?? "");
  // `template:` is read value-strict from the raw FM slice (NOT the js-yaml
  // object) so the sidebar/list path and the dialect read helper share one
  // definition — mirrors the `trashed:` rationale above.
  const template = readTemplateFromFmBody(slice.frontmatter_bytes ?? "");
  // `folder_index:` read value-strict from the raw FM slice, same rationale as
  // `template:`/`trashed:` — js-yaml would coerce `true` to a boolean and a
  // user's `folder_index: "true"` would not stay value-strict.
  const folderIndex = readFolderIndexFromFmBody(slice.frontmatter_bytes ?? "");
  // `conflict:`/`conflict_of:` read value-strict from the raw FM slice (MYND-427)
  // — same rationale as `template:` (js-yaml would coerce the boolean).
  const conflict = readConflictFromFmBody(slice.frontmatter_bytes ?? "");
  const conflictOf = readConflictOfFromFmBody(slice.frontmatter_bytes ?? "");
  // `source:` is an UNMANAGED provenance key the clipper writes (url-bookmark /
  // SYNC-16) — presence, not value, signals "this is a bookmark". Reuse the
  // already-parsed js-yaml object (same source as `folder:`/`updated:`); a
  // malformed-YAML body parses to `{}` here, so a bookmark with broken FM falls
  // back to the ordinary `file-text` glyph rather than throwing.
  const hasSource = Object.prototype.hasOwnProperty.call(parsed, "source");
  // `kind:` read value-strict from the raw FM slice, same rationale as
  // `template:`/`folder_index:` — js-yaml would coerce the value and a user's
  // `kind: "drawing"` (quoted) must NOT read as the canonical marker.
  const kind = readKindFromFmBody(slice.frontmatter_bytes ?? "");
  return {
    noteUuid: slice.note_uuid,
    title: titleFromFm,
    folder: normalizeFolderPath(folderRaw),
    updatedAt: deriveUpdatedAt(parsed),
    trashed,
    deleted,
    archived,
    template,
    folderIndex,
    conflict,
    conflictOf,
    hasSource,
    kind,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Load the title + `updated_at` Date for each input note ID.
 *
 * Splits the input into ≤ `NOTE_TITLES_BATCH_CAP`-sized chunks, fires
 * them in parallel via `Promise.all`, flattens results in input order,
 * and derives `TitleRecord` per item. Per-item backend failures surface
 * as `TitleRecord { title: null, updatedAt: null, error }` keyed by the
 * input ID at that position.
 *
 * Outer rejection propagates `NoteTitleBatchError` from the underlying
 * IPC call (e.g., slot locked mid-fetch).
 */
export async function loadNoteBatch(ids: string[]): Promise<TitleRecord[]> {
  if (ids.length === 0) return [];

  const chunks = chunk(ids, NOTE_TITLES_BATCH_CAP);
  const chunkResults = await Promise.all(
    chunks.map((c) => noteTitlesBatch(c)),
  );
  const flattened = chunkResults.flat();

  return flattened.map((r, idx) => {
    if ("Ok" in r) {
      return recordFromSlice(r.Ok);
    }
    const fallbackId = ids[idx] ?? "";
    return {
      noteUuid: fallbackId,
      title: null,
      folder: null,
      updatedAt: null,
      trashed: null,
      deleted: null,
      archived: null,
      template: false,
      folderIndex: false,
      conflict: false,
      conflictOf: null,
      hasSource: false,
      kind: null,
      error: r.Err,
    };
  });
}
