// Obsidian importer — production IO wiring (the real `ImportPorts` + run helper).
//
// Sub-feature 3 of the obsidian-importer epic (MYND-53), tasks 6–9 (UI glue).
//
// The engine (`engine.ts`) is pure orchestration over an injected `ImportPorts`
// so it stays unit-testable without Tauri. THIS module is the production factory
// that binds those ports to the real commands:
//   - `readDir` / `readFile` → the narrow `importer:` read-seam (SYNC-1) — the
//     ONLY external-dir read path; the picked root is passed as the validation
//     root so every read is checked within-root host-side. No WebView fs-read.
//   - `createNote`           → `notes:note_create` (mints the UUIDv7, encrypts,
//     atomic-writes the `.myn`). The engine never touches AEAD/magic/identifiers.
//   - `setDeliberateFolders` → `prefs:set_deliberate_folders`, UNIONED with the
//     vault's current set (the wrapper writes the full set verbatim, so the union
//     must happen here or pre-existing empty folders would be clobbered — SYNC-4).
//
// Media (SYNC-7 hybrid auto-ingest) is wired via a `RefImporter` that resolves a
// note's local media ref against the source vault — trying the note-relative /
// vault-root path first, then a vault-wide basename index (Obsidian's
// shortest-path embeds, `![[image.png]]`) — and ingests it through
// `attachments:attachment_import {kind:"path"}` (the host reads the file; never
// WebView fs-read). A ref that resolves nowhere falls back to the omitted tally.
// Resolution is a documented v0.1 heuristic: an ambiguous basename resolves to
// the first match found in the walk.

import { invoke } from "@tauri-apps/api/core";
import { noteCreate } from "../createNote";
import { noteList } from "../listNotes";
import { loadNoteBatch, type TitleRecord } from "../loadNoteBatch";
import { prefsRead, setDeliberateFolders } from "../../lib/prefs";
import { buildExistingIdentitySet, type ExistingNote, type DuplicatePolicy } from "./conflict";
import {
  importFromSource,
  importVault,
  type ImportDirEntry,
  type ImportPorts,
  type ImportResult,
} from "./engine";
import { createObsidianSource } from "./sources/obsidian";
import { createHtmlSource } from "./sources/html";
import { createNotionSource } from "./sources/notion";
import { createCsvSource } from "./sources/csv";
import { createEnexSource } from "./sources/enex";
import { buildImportReport, formatStamp } from "./report";
import type { ImportSource, ImportSourceId } from "./source";
import type { RefImporter } from "./media";
import { joinPath } from "./source";
import { attachmentImport } from "../../lib/attachments";

/** Rust `ImportDirEntry` wire shape (snake_case `is_dir`). */
interface RustDirEntry {
  name: string;
  is_dir: boolean;
}

/** List a directory's entries via the read-seam, validated within `root`. */
export async function importReadDir(root: string, path: string): Promise<ImportDirEntry[]> {
  const entries = await invoke<RustDirEntry[]>("plugin:importer|import_read_dir", {
    root,
    path,
  });
  return entries.map((e) => ({ name: e.name, isDir: e.is_dir }));
}

/** Read a file's UTF-8 source bytes via the read-seam, validated within `root`. */
export async function importReadFile(root: string, path: string): Promise<string> {
  return await invoke<string>("plugin:importer|import_read_file", { root, path });
}

// `joinPath` is imported from the seam, not redefined: the media index below is
// keyed by the paths the WALK produced, so the two must agree byte-for-byte.

/**
 * Union the importer's empty-dir folders with the vault's existing
 * `deliberate_folders` (pure; the Rust codec sorts + exact-dedups on write, so
 * order here is irrelevant). Without this the importer's write would replace —
 * not extend — the user's pre-existing deliberate folders (SYNC-4).
 */
export function mergeDeliberateFolders(
  existing: readonly string[],
  add: readonly string[],
): string[] {
  const set = new Set<string>(existing);
  for (const f of add) set.add(f);
  return [...set];
}

/** Project the sidebar's `TitleRecord`s to the conflict module's `ExistingNote`
 *  identity shape (folder + title + lifecycle). `trashed`/`template` pass through
 *  unchanged — `buildExistingIdentitySet` excludes trashed/template/untitled. */
export function titleRecordsToExistingNotes(
  records: readonly TitleRecord[],
): ExistingNote[] {
  return records.map((r) => ({
    folder: r.folder,
    title: r.title,
    trashed: r.trashed,
    template: r.template,
  }));
}

/** Build the live-vault `(folder,title)` identity set from the authoritative
 *  note list (not the partial sidebar cache) for the SYNC-5 idempotent skip. */
export async function loadExistingIdentity(): Promise<Set<string>> {
  const ids = await noteList();
  const records = await loadNoteBatch(ids);
  return buildExistingIdentitySet(titleRecordsToExistingNotes(records));
}

/** Real ports bound to the picked vault `root`. */
export function createImportPorts(root: string): ImportPorts {
  return {
    readDir: (absPath) => importReadDir(root, absPath),
    readFile: (absPath) => importReadFile(root, absPath),
    createNote: (plaintext) => noteCreate(plaintext),
    setDeliberateFolders: async (folders) => {
      let existing: string[] = [];
      try {
        existing = (await prefsRead()).deliberate_folders;
      } catch {
        // Prefs read failure → fall back to writing just the importer's set
        // (best-effort; the SYNC-4 empty-dir carrier is non-load-bearing).
        existing = [];
      }
      await setDeliberateFolders(mergeDeliberateFolders(existing, folders));
    },
  };
}

/**
 * Candidate absolute paths for one media ref's `source`, in resolution order:
 *   1. the source joined to the vault root (note-/vault-relative refs),
 *   2. the source's basename looked up in the vault-wide media index
 *      (Obsidian shortest-path `![[image.png]]` embeds).
 * Deduplicated, order-preserving. Pure (no IO) so it's unit-testable.
 *
 * SECURITY (TB6 least-privilege): a note body is UNTRUSTED imported content, and
 * `attachment_import {kind:"path"}` reads ARBITRARY host paths — unlike the
 * within-root-validated read-seam used for `.md`. So a crafted ref must not
 * escape the picked root: an **absolute** source (`/etc/passwd.png`) and a source
 * carrying a **`..` segment** (`../../x.png`) emit NO root-relative candidate.
 * The basename-index candidate is within-root by construction (built from the
 * validated walk under `root`, dot-dirs skipped), so a legitimate `../assets/x.png`
 * still resolves through it. (Residual: a symlink INSIDE the vault pointing
 * outward — `attachment_import` doesn't canonicalize like the read-seam does;
 * tracked as a host-side-validation follow-up.)
 */
export function mediaCandidatePaths(
  root: string,
  mediaIndex: ReadonlyMap<string, string>,
  source: string,
): string[] {
  const norm = source.replace(/\\/g, "/").replace(/^\.\//, "");
  const candidates: string[] = [];
  const isAbsolute = norm.startsWith("/") || /^[A-Za-z]:\//.test(norm);
  const hasTraversal = norm.split("/").some((seg) => seg === "..");
  if (!isAbsolute && !hasTraversal) {
    candidates.push(joinPath(root, norm));
  }
  const basename = norm.split("/").pop() ?? norm;
  const indexed = mediaIndex.get(basename.toLowerCase());
  if (indexed !== undefined) candidates.push(indexed);
  return candidates.filter((c, i) => candidates.indexOf(c) === i);
}

/**
 * Walk the source vault once (entries only, no content) to build a
 * basename→absolute-path index for media resolution. Dot-entries are skipped
 * (the SYNC-10 ignore set), so `.obsidian/` assets never resolve. First match
 * wins for a duplicated basename (documented v0.1 ambiguity). Best-effort: a
 * read failure on a subtree just yields a smaller index.
 */
export async function buildMediaIndex(
  root: string,
  ports: ImportPorts,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const walk = async (relDir: string): Promise<void> => {
    let entries: ImportDirEntry[];
    try {
      entries = await ports.readDir(joinPath(root, relDir));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = relDir.length === 0 ? e.name : `${relDir}/${e.name}`;
      if (e.isDir) {
        await walk(rel);
      } else {
        const key = e.name.toLowerCase();
        if (!index.has(key)) index.set(key, joinPath(root, rel));
      }
    }
  };
  await walk("");
  return index;
}

/** Resolve+ingest a media ref against the source vault — the production
 *  `RefImporter` the engine consumes (SYNC-7). Tries each candidate path until
 *  one ingests; resolves nowhere → `{ ok: false }` (the omitted tally). */
export function createMediaRefImporter(
  root: string,
  mediaIndex: ReadonlyMap<string, string>,
): RefImporter {
  return async (ref) => {
    for (const path of mediaCandidatePaths(root, mediaIndex, ref.source)) {
      try {
        const attachment = await attachmentImport({ kind: "path", path });
        return { ok: true, attachment };
      } catch {
        // Unresolvable / unsupported / oversize / locked → try the next
        // candidate; exhausting them falls through to the omitted tally.
      }
    }
    return { ok: false };
  };
}

export interface RunImportOptions {
  onProgress?: (done: number, total: number) => void;
  shouldCancel?: () => boolean;
}

/**
 * End-to-end vault import from a picked `root` under the given duplicate
 * `policy`: build the live identity set + the media index, then run the engine
 * with the real ports + media importer. Returns the frozen SYNC-2 `ImportResult`
 * the summary screen renders. No plaintext ever touches disk — only the
 * encrypted `.myn` blobs (via `note_create`) + attachment blobs are written.
 */
export async function runVaultImport(
  root: string,
  policy: DuplicatePolicy,
  options: RunImportOptions = {},
): Promise<ImportResult> {
  const ports = createImportPorts(root);
  // The two prep steps are independent (one decrypts the destination vault's
  // titles, the other walks the source tree) — overlap them so the "Scanning…"
  // latency is the slower of the two, not their sum.
  const [existingIdentity, mediaIndex] = await Promise.all([
    loadExistingIdentity(),
    buildMediaIndex(root, ports),
  ]);
  const importMedia = createMediaRefImporter(root, mediaIndex);
  return importVault(root, ports, existingIdentity, policy, {
    onProgress: options.onProgress,
    shouldCancel: options.shouldCancel,
    importMedia,
  });
}

/**
 * End-to-end import from ANY source (importer-breadth epic, MYND-579…586).
 *
 * The generalization of {@link runVaultImport}: pick the adapter for `source`, run it
 * through the one shared ingest loop, then write the import-report note if anything
 * arrived degraded. `root` is the picked directory for tree sources
 * (Obsidian / HTML / Notion) or the picked FILE for single-file sources
 * (Evernote / CSV).
 *
 * Media resolution stays tree-shaped: only the directory sources build a basename
 * index, because a single-file source has no sibling media to resolve against
 * (Evernote's resources are base64-inline and ingest through the bytes seam instead).
 */
export async function runSourceImport(
  source: ImportSourceId,
  root: string,
  policy: DuplicatePolicy,
  options: RunImportOptions = {},
): Promise<ImportResult> {
  const ports = createImportPorts(root);
  const treeShaped = source === "obsidian" || source === "html" || source === "notion";

  const [existingIdentity, mediaIndex] = await Promise.all([
    loadExistingIdentity(),
    treeShaped ? buildMediaIndex(root, ports) : Promise.resolve(new Map<string, string>()),
  ]);

  const adapter: ImportSource =
    source === "obsidian"
      ? createObsidianSource(root, ports)
      : source === "html"
        ? createHtmlSource(root, ports)
        : source === "notion"
          ? createNotionSource(root, ports)
          : source === "csv"
            ? createCsvSource(root, ports)
            : createEnexSource(root, ports, {
                // Evernote inlines every resource as base64, so ingestion needs the
                // BYTES seam rather than the path-based media resolver.
                ingestBytes: async (bytes, filename) => {
                  try {
                    const att = await attachmentImport({
                      kind: "bytes",
                      bytes: Array.from(bytes),
                      filename,
                    });
                    return { id: att.id, filename: att.filename ?? filename };
                  } catch {
                    return null; // oversize / unsupported → placeholder + reported loss
                  }
                },
              });

  const result = await importFromSource(adapter, ports, existingIdentity, policy, {
    onProgress: options.onProgress,
    shouldCancel: options.shouldCancel,
    importMedia: treeShaped ? createMediaRefImporter(root, mediaIndex) : undefined,
  });

  // The report is written LAST, after the ingest loop, so it can name every affected
  // note — and it is created after `existingIdentity` was snapshotted, so it is never
  // in the dedup set and cannot suppress itself on a re-import.
  const report = buildImportReport(source, result, formatStamp(new Date()));
  if (report !== null) {
    try {
      await ports.createNote(report);
    } catch {
      // A failed report must never fail an otherwise-successful import: the notes are
      // already written, and the tallies on `result` still surface in the summary.
    }
  }

  return result;
}
