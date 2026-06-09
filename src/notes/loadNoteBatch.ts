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

import { invoke } from "@tauri-apps/api/core";
import { load as parseYaml } from "js-yaml";
import {
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
  // `template:` is read value-strict from the raw FM slice (NOT the js-yaml
  // object) so the sidebar/list path and the dialect read helper share one
  // definition — mirrors the `trashed:` rationale above.
  const template = readTemplateFromFmBody(slice.frontmatter_bytes ?? "");
  return {
    noteUuid: slice.note_uuid,
    title: titleFromFm,
    folder: normalizeFolderPath(folderRaw),
    updatedAt: deriveUpdatedAt(parsed),
    trashed,
    template,
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
      template: false,
      error: r.Err,
    };
  });
}
