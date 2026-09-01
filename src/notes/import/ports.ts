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

import { invoke } from "../../platform/core";
import { noteCreate } from "../createNote";
import { noteList } from "../listNotes";
import { loadNoteBatch, type TitleRecord } from "../loadNoteBatch";
import { mutateDeliberateFolders } from "../../lib/prefs";
import {
  buildExistingIdentitySet,
  hashBodyForIdentity,
  type ExistingNote,
  type DuplicatePolicy,
} from "./conflict";
import { noteRead } from "../readNote";
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
import { decideLinkedEntry, joinPath, type UnfollowedLink } from "./source";
import { attachmentImport } from "../../lib/attachments";
import {
  importPicked,
  readPickedText,
  type PickedTree,
} from "../../platform/filePicker";
import type { PickedFile } from "@myne/editor";

/** Rust `EntryLink` wire shape (internally tagged on `status`). */
type RustEntryLink =
  | { status: "followable"; target_key: string }
  | { status: "outside" }
  | { status: "loop" }
  | { status: "broken" };

/** Rust `ImportDirEntry` wire shape (snake_case `is_dir`). */
interface RustDirEntry {
  name: string;
  is_dir: boolean;
  link: RustEntryLink | null;
}

/** List a directory's entries via the read-seam, validated within `root`. */
export async function importReadDir(root: string, path: string): Promise<ImportDirEntry[]> {
  const entries = await invoke<RustDirEntry[]>("plugin:importer|import_read_dir", {
    root,
    path,
  });
  return entries.map((e) => ({
    name: e.name,
    isDir: e.is_dir,
    link:
      e.link === null
        ? null
        : e.link.status === "followable"
          ? { status: "followable", targetKey: e.link.target_key }
          : { status: e.link.status },
  }));
}

/** Read a file's UTF-8 source bytes via the read-seam, validated within `root`. */
export async function importReadFile(root: string, path: string): Promise<string> {
  return await invoke<string>("plugin:importer|import_read_file", { root, path });
}

/**
 * Take or drop the host's import lease, which DEFERS the idle auto-lock while
 * an import runs (myne-md/myne#223). Best-effort: failing to take it means the
 * import may be interrupted by the lock, which is the behaviour that shipped —
 * never a reason to fail the import itself.
 */
export async function importSetHold(active: boolean): Promise<void> {
  await invoke<void>("plugin:importer|import_set_hold", { active });
}

// `joinPath` is imported from the seam, not redefined: the media index below is
// keyed by the paths the WALK produced, so the two must agree byte-for-byte.

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

/** The untitled half, given a batch somebody else already paid for. */
async function untitledIdentitiesFrom(
  records: Awaited<ReturnType<typeof loadNoteBatch>>,
): Promise<{ folder: string | null; bodyHash: string }[]> {
  const untitled = records.filter(
    (r) => r.title === null && r.trashed === null && !r.template,
  );
  const out: { folder: string | null; bodyHash: string }[] = [];
  for (const record of untitled) {
    try {
      out.push({
        folder: record.folder,
        bodyHash: hashBodyForIdentity(await noteRead(record.noteUuid)),
      });
    } catch {
      // A note that will not read cannot contribute an identity. Skipping it
      // means at worst one duplicate on a re-import, where failing the whole
      // import would mean none of the notes arrive at all.
    }
  }
  return out;
}

/** Build the live-vault `(folder,title)` identity set from the authoritative
 *  note list (not the partial sidebar cache) for the SYNC-5 idempotent skip. */
export async function loadExistingIdentity(): Promise<Set<string>> {
  const ids = await noteList();
  const records = await loadNoteBatch(ids);
  return buildExistingIdentitySet(titleRecordsToExistingNotes(records));
}

/**
 * Both halves of the identity snapshot in ONE pass over the vault.
 *
 * A Myne import needs the titled set and the untitled body hashes, and calling
 * the two loaders above did the walk twice: two `noteList()` calls and two
 * `loadNoteBatch()` decrypts of every note in the target, concurrently, for a
 * result that is a pure function of one read. On a vault of any size that is the
 * single most expensive thing the import does before it has imported anything.
 *
 * The untitled half still costs one `noteRead` per untitled note, which the
 * batch does not carry: `loadNoteBatch` returns titles and lifecycle flags, and
 * the untitled key is a hash of the BODY. That read is unavoidable and is not
 * what this shares.
 */
export async function loadIdentitySnapshot(): Promise<{
  titled: Set<string>;
  untitled: { folder: string | null; bodyHash: string }[];
}> {
  const ids = await noteList();
  const records = await loadNoteBatch(ids);
  return {
    titled: buildExistingIdentitySet(titleRecordsToExistingNotes(records)),
    untitled: await untitledIdentitiesFrom(records),
  };
}

// ── the tree-backed arm (phase3-web-client task 71) ──────────────────────────
//
// # Why the port is this small
//
// The engine was already injected-IO over `ImportPorts`, and the string algebra
// it uses — `joinPath(root, rel)` — is platform-free. So a client whose picker
// hands back the WALK instead of a path does not need a different engine, a
// different adapter, a different media index or a different `mediaCandidatePaths`.
// It needs the same two functions reading from a Map. Everything above this line
// is unchanged, and that is the result of the seam, not a coincidence.
//
// What does NOT port is the Rust `importer` plugin, and that is the part worth
// stating: `import_read_dir` / `import_read_file` are a least-privilege READ
// SEAM (canonicalise + within-root check) that exists because the WebView is
// denied `fs:allow-read-dir`. A browser has no absolute path, no `canonicalize`
// and no host to confine to — moving it would relocate a security mechanism to a
// platform where it protects nothing.

/**
 * Index a picked tree's entries by the ABSOLUTE-shaped key the walk produces.
 *
 * `joinPath(root, rel)` is the same key `readDir`/`readFile` are called with, so
 * indexing by it is what lets the tree ports answer the engine's existing calls
 * with no translation layer. Exported for its own test: a key that disagrees with
 * the walk by one separator makes every read miss and the import silently empty.
 */
export function indexTree(tree: PickedTree): Map<string, PickedFile> {
  const map = new Map<string, PickedFile>();
  for (const entry of tree.entries ?? []) {
    map.set(joinPath(tree.root, entry.path), entry.file);
  }
  return map;
}

/**
 * List one directory's immediate children out of a flat file index.
 *
 * A browser hands back FILES only — directories exist in the listing purely as
 * path prefixes — so this reconstructs them. Names are de-duplicated (many files
 * share one parent) and a directory shadows a file of the same name, which
 * cannot happen in a real tree and would otherwise depend on iteration order.
 *
 * `link` is always `null` here: a flat file index has no symlinks to resolve —
 * the platform already walked the tree and handed back whatever it found behind
 * one. That is why the symlinked-subtree defect was desktop-only.
 */
export function readDirFromIndex(
  index: ReadonlyMap<string, PickedFile>,
  absPath: string,
): ImportDirEntry[] {
  const prefix = absPath.endsWith("/") ? absPath : `${absPath}/`;
  const seen = new Map<string, boolean>();
  for (const key of index.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (rest.length === 0) continue;
    const cut = rest.indexOf("/");
    const name = cut === -1 ? rest : rest.slice(0, cut);
    const isDir = cut !== -1;
    if (isDir || !seen.has(name)) seen.set(name, isDir || (seen.get(name) ?? false));
  }
  return [...seen].map(([name, isDir]) => ({ name, isDir, link: null }));
}

/**
 * Ports backed by a picked tree the platform already walked.
 *
 * `createNote` / `setDeliberateFolders` are shared verbatim with the host-backed
 * arm — the write half of the importer is identical on every client, and only
 * the READ half differs. A missing key is a `NotFound`-shaped throw rather than
 * an empty string, so a walk bug surfaces as a failure instead of as a note that
 * imported with no content.
 */
export function createTreePorts(tree: PickedTree): ImportPorts {
  const index = indexTree(tree);
  const host = createImportPorts(tree.root);
  return {
    readDir: async (absPath) => readDirFromIndex(index, absPath),
    readFile: async (absPath) => {
      const file = index.get(absPath);
      if (file === undefined) throw new Error("import: no such file in the picked tree");
      return await readPickedText(file);
    },
    createNote: host.createNote,
    setDeliberateFolders: host.setDeliberateFolders,
  };
}

/**
 * The tree-backed {@link RefImporter}: resolve a media ref inside the picked
 * tree, then ingest it through the platform's own import route.
 *
 * Candidate resolution is `mediaCandidatePaths` UNCHANGED — the same
 * absolute-and-traversal refusals, the same basename index. That matters for
 * more than tidiness: those refusals are the TB6 guard against a crafted ref in
 * untrusted imported content reaching outside the picked root, and a second copy
 * of them would be a second place to get them wrong. Here a candidate that
 * escapes simply is not a key in the map, so the guard is belt-and-braces.
 */
export function createTreeMediaRefImporter(
  tree: PickedTree,
  mediaIndex: ReadonlyMap<string, string>,
): RefImporter {
  const index = indexTree(tree);
  return async (ref) => {
    for (const path of mediaCandidatePaths(tree.root, mediaIndex, ref.source)) {
      const file = index.get(path);
      if (file === undefined) continue;
      try {
        const attachment = await importPicked(file);
        return { ok: true, attachment };
      } catch {
        // Oversize / unsupported / refused → try the next candidate; exhausting
        // them falls through to the omitted tally, exactly as on the host arm.
      }
    }
    return { ok: false };
  };
}

/**
 * The ports for a picked tree, whichever shape the platform produced.
 *
 * ONE entry point so a caller never branches on `entries` itself — the branch
 * exists once, here, and a new caller cannot forget it.
 */
export function portsForTree(tree: PickedTree): ImportPorts {
  return tree.entries === null ? createImportPorts(tree.root) : createTreePorts(tree);
}

/** The media importer for a picked tree, same one-branch discipline. */
export function mediaImporterForTree(
  tree: PickedTree,
  mediaIndex: ReadonlyMap<string, string>,
): RefImporter {
  return tree.entries === null
    ? createMediaRefImporter(tree.root, mediaIndex)
    : createTreeMediaRefImporter(tree, mediaIndex);
}

/** Real ports bound to the picked vault `root`. */
/**
 * Ports for a source with NO external directory at all.
 *
 * The Myne vault source reads another vault through the host's own key slot, so
 * it never touches the external-directory read seam. `readDir` / `readFile`
 * therefore have nothing legitimate to return and throw rather than answering
 * something plausible: a source that reached them would be reading a path it has
 * no business reading, and a silent empty answer is how that becomes a bug
 * nobody sees. `createNote`, `setDeliberateFolders` and `setImportHold` are the
 * real ones, and they are the whole of what the engine needs here.
 */
export function createVaultOnlyPorts(): ImportPorts {
  const refuse = (): never => {
    throw new Error("this import source reads no external directory");
  };
  const real = createImportPorts("");
  return {
    readDir: refuse,
    readFile: refuse,
    createNote: real.createNote,
    setDeliberateFolders: real.setDeliberateFolders,
    setImportHold: real.setImportHold,
  };
}

export function createImportPorts(root: string): ImportPorts {
  return {
    readDir: (absPath) => importReadDir(root, absPath),
    readFile: (absPath) => importReadFile(root, absPath),
    // `null` because the importer is a BULK path: `engine.ts` collects every
    // folder it created and issues ONE `setDeliberateFolders` at the end. A
    // per-note registration here would re-encrypt the whole `vault.prefs` blob
    // once per imported note (myne-md/myne#613).
    createNote: (plaintext) => noteCreate(plaintext, null),
    // myne#613: no read, and therefore no fallback. The importer says "add
    // these"; the backend unions them into whatever is stored. Before the verbs
    // existed this had to read the set, union locally and write the whole thing
    // back, and its catch fell back to the EMPTY set on a read failure. That was
    // harmless while the merge was a clockless union and became a broadcast
    // delete of every registered folder the moment removals started
    // propagating: the write claimed an absence it had never checked.
    setDeliberateFolders: async (folders) =>
      await mutateDeliberateFolders({ add: [...folders] }),
    setImportHold: (active) => importSetHold(active),
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
 *
 * This is a SECOND full walk of the tree, structurally separate from the
 * adapter's `plan()`, so it needs the symlink rules of its own — otherwise a
 * symlinked folder's images would be unresolvable in notes the plan does now
 * import (myne-md/myne#223). Refusals are dropped rather than collected: the
 * plan's walk already names each one, and reporting the same link twice would
 * double every row.
 */
export async function buildMediaIndex(
  root: string,
  ports: ImportPorts,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const visitedLinkTargets = new Set<string>();
  const discardedRefusals: UnfollowedLink[] = [];
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
      if (decideLinkedEntry(e, rel, visitedLinkTargets, discardedRefusals) === "skip") {
        continue;
      }
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

/** Renew the host's auto-lock lease well inside its 60 s ceiling. */
const IMPORT_HOLD_RENEW_MS = 20_000;

/**
 * Run `body` with the host's idle auto-lock DEFERRED (myne-md/myne#223).
 *
 * The lease lives here rather than in `engine.ts` or the modal because this is
 * the layer that already knows which host it is talking to: `portsForTree`
 * picks the arm, and only the desktop arm implements `setImportHold`. The
 * engine stays host-agnostic and the modal stays a view.
 *
 * Every lease call is swallowed: an import that runs to completion with an
 * un-renewed lease is exactly the behaviour that shipped before, whereas an
 * import that FAILS because it could not defer a lock would be a new way to
 * lose an import.
 */
export async function withImportHold<T>(
  ports: ImportPorts,
  body: () => Promise<T>,
): Promise<T> {
  const setHold = ports.setImportHold;
  if (setHold === undefined) return body();

  const renew = () => {
    void setHold(true).catch(() => {});
  };
  renew();
  const timer = setInterval(renew, IMPORT_HOLD_RENEW_MS);
  try {
    return await body();
  } finally {
    clearInterval(timer);
    // Drop it rather than letting it lapse: the user may have walked away
    // during a long import, and the vault should lock on the next tick rather
    // than up to a minute later.
    void setHold(false).catch(() => {});
  }
}

/**
 * End-to-end vault import from a picked `root` under the given duplicate
 * `policy`: build the live identity set + the media index, then run the engine
 * with the real ports + media importer. Returns the frozen SYNC-2 `ImportResult`
 * the summary screen renders. No plaintext ever touches disk — only the
 * encrypted `.myn` blobs (via `note_create`) + attachment blobs are written.
 */
export async function runVaultImport(
  tree: PickedTree,
  policy: DuplicatePolicy,
  options: RunImportOptions = {},
): Promise<ImportResult> {
  const root = tree.root;
  const ports = portsForTree(tree);
  // The two prep steps are independent (one decrypts the destination vault's
  // titles, the other walks the source tree) — overlap them so the "Scanning…"
  // latency is the slower of the two, not their sum.
  const [existingIdentity, mediaIndex] = await Promise.all([
    loadExistingIdentity(),
    buildMediaIndex(root, ports),
  ]);
  const importMedia = mediaImporterForTree(tree, mediaIndex);
  return withImportHold(ports, () =>
    importVault(root, ports, existingIdentity, policy, {
      onProgress: options.onProgress,
      shouldCancel: options.shouldCancel,
      importMedia,
    }),
  );
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
  tree: PickedTree,
  policy: DuplicatePolicy,
  options: RunImportOptions = {},
): Promise<ImportResult> {
  const root = tree.root;
  const ports = portsForTree(tree);
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
                // The WHOLE attachment is handed back, not `{id, filename}`: the
                // adapter tallies ingest-time compression off `original_size`,
                // and narrowing here is what once made this route — the one bulk
                // importer with no media path — compress in silence.
                ingestBytes: async (bytes, filename) => {
                  try {
                    const att = await attachmentImport({
                      kind: "bytes",
                      bytes: Array.from(bytes),
                      filename,
                    });
                    return { ...att, filename: att.filename ?? filename };
                  } catch {
                    return null; // oversize / unsupported → placeholder + reported loss
                  }
                },
              });

  const result = await withImportHold(ports, () =>
    importFromSource(adapter, ports, existingIdentity, policy, {
      onProgress: options.onProgress,
      shouldCancel: options.shouldCancel,
      importMedia: treeShaped ? mediaImporterForTree(tree, mediaIndex) : undefined,
    }),
  );

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
