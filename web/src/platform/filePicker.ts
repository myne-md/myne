// Web implementation of the file-picker seam (phase3-web-client task 76).
//
// The whole point of this seam is that a browser's picker hands back a `File`,
// never a path — so this is the side that made the seam's result type opaque in
// the first place. `handle` is the `File` itself; the web host is the only thing
// that unwraps it, and it does so by streaming the bytes into the Worker rather
// than by asking anyone to open a path.
//
// # Cancel has no reliable event, and that shapes the promise
//
// `<input type="file">` fires `change` on pick. Cancellation is signalled by the
// `cancel` event where supported and by nothing at all elsewhere, so this
// listens for both and leaves the promise pending in the browsers that report
// neither — the same behaviour `web/src/platform/dialog.ts` already documents.
// A picker is single-shot either way: the element is discarded after one use.

import type { ImportedAttachment, PickedFile } from "@myne/editor";
import { invokeWithFile } from "../worker/host";

/** Mirrors the desktop options. Extensions become an `accept` hint, which a
 *  browser treats as advisory — the user can still choose anything, so nothing
 *  downstream may rely on it. */
export interface PickFilesOptions {
  readonly multiple?: boolean;
  readonly extensions?: readonly string[];
  readonly filterLabel?: string;
}

/** The web handle: the `File` the picker produced. */
interface FileHandle {
  readonly kind: "file";
  readonly file: File;
}

/** Wrap a `File` as an opaque picked file.
 *
 * Unlike the desktop arm, `size` and `mimeHint` are known for free here — a
 * `File` carries both — so they are filled in. `mimeHint` stays a HINT: the
 * content type is re-sniffed from the decrypted bytes host-side and a browser's
 * claimed MIME is never trusted (`protocol.md` §9.9).
 */
export function pickedFromFile(file: File): PickedFile {
  return {
    name: file.name,
    size: file.size,
    mimeHint: file.type !== "" ? file.type : null,
    handle: { kind: "file", file } satisfies FileHandle,
  };
}

/** The `File` behind a handle this module minted, or `null` for a foreign one. */
export function fileFor(picked: PickedFile): File | null {
  const handle = picked.handle as Partial<FileHandle> | null;
  return handle?.kind === "file" && handle.file instanceof File ? handle.file : null;
}

/** Open the browser's file picker. Resolves `null` on cancel. */
export async function pickFiles(opts?: PickFilesOptions): Promise<PickedFile[] | null> {
  return await new Promise<PickedFile[] | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = opts?.multiple === true;
    if (opts?.extensions !== undefined && opts.extensions.length > 0) {
      input.accept = opts.extensions.map((e) => `.${e.replace(/^\./, "")}`).join(",");
    }
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      resolve(files.length === 0 ? null : files.map(pickedFromFile));
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

export type { PickedTree, PickedTreeEntry } from "../../../src/platform/filePicker";
import type { PickedTree, PickedTreeEntry } from "../../../src/platform/filePicker";

/**
 * Split a `webkitRelativePath` into the root folder name and the path beneath it.
 *
 * The browser reports `MyVault/notes/a.md` — always prefixed with the picked
 * folder's own name, which is the ONLY thing a page ever learns about where the
 * folder lives. Returns `null` for a path with no separator at all, which should
 * not occur for a directory pick and would otherwise produce an entry with an
 * empty relative path that the importer would map to the vault root.
 *
 * Exported for its own test: this is the one piece of string handling here, and
 * getting it wrong silently reparents every imported note.
 */
export function splitRelativePath(relative: string): { root: string; path: string } | null {
  const cut = relative.indexOf("/");
  if (cut <= 0 || cut === relative.length - 1) return null;
  return { root: relative.slice(0, cut), path: relative.slice(cut + 1) };
}

/**
 * Open the browser's DIRECTORY picker (phase3-web-client task 71).
 *
 * `webkitdirectory` is what makes a folder pick possible at all — it is
 * non-standard by name and universally implemented, and there is no standard
 * alternative that works in every target browser (the File System Access API's
 * `showDirectoryPicker` is not in Firefox or Safari).
 *
 * Unlike desktop this returns the ENTRIES, because the browser has already
 * walked the tree: the picker's result IS the file list, each carrying its
 * `webkitRelativePath`. Nothing is widened — a page still cannot see a file the
 * user did not hand it, and no path is learned beyond the folder's own name.
 *
 * Files whose relative path has no folder component are dropped rather than
 * mapped to the root: the browser is expected to prefix every entry, and an
 * unprefixed one means an assumption broke. Silently importing it at the vault
 * root would put a note somewhere the user did not choose.
 */
export async function pickDirectory(): Promise<PickedTree | null> {
  return await new Promise<PickedTree | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    // Both spellings: the property is what browsers implement, the attribute is
    // what some older ones read. Setting the property alone has been enough
    // everywhere tested, and the attribute costs one line to not have to find out.
    input.webkitdirectory = true;
    input.setAttribute("webkitdirectory", "");
    input.multiple = true;
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        resolve(null);
        return;
      }
      let root: string | null = null;
      const entries: PickedTreeEntry[] = [];
      for (const file of files) {
        const split = splitRelativePath(file.webkitRelativePath);
        if (split === null) continue;
        root ??= split.root;
        entries.push({ path: split.path, file: pickedFromFile(file) });
      }
      resolve(root === null ? null : { root, entries });
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/**
 * Open the browser's FILE picker as a one-entry {@link PickedTree}
 * (phase3-web-client task 71).
 *
 * The single-file sources call `readFile(root)` with the root itself, so the one
 * entry is keyed at the EMPTY relative path — `joinPath(root, "")` is `root` by
 * definition, which is what makes the tree ports answer that call without a
 * special case for "the root is the file".
 */
export async function pickFileAsTree(opts?: PickFilesOptions): Promise<PickedTree | null> {
  const picked = await pickFiles({ ...opts, multiple: false });
  const first = picked?.[0];
  if (first === undefined) return null;
  return { root: first.name, entries: [{ path: "", file: first }] };
}

/**
 * Read a picked file's UTF-8 text (phase3-web-client task 71).
 *
 * # Why this reads on the PAGE, and why that is not a task-67 violation
 *
 * Task 67's rule is that attachment BYTES never get assembled here — a 64 MiB
 * file spread into a `number[]` and `JSON.stringify`d is an out-of-memory path.
 * Markdown SOURCE is a different thing: the importer's parser is TypeScript and
 * runs on this thread, so the text has to be here to be parsed. Desktop is
 * identical in this respect — `import_read_file` returns a `String` across IPC
 * into the very same page — so this is parity, not a web-side concession.
 *
 * Media inside those notes still takes task 67's route: `importPicked` hands the
 * `File` HANDLE to the Worker and nothing large crosses this thread.
 */
export async function readPickedText(picked: PickedFile): Promise<string> {
  const file = fileFor(picked);
  if (file === null) {
    throw new Error("picked file was not minted by this host");
  }
  return await file.text();
}

/**
 * Import a picked file into the vault (phase3-web-client task 67).
 *
 * # The bytes never touch this thread
 *
 * The obvious implementation — `await file.arrayBuffer()`, spread into the
 * shared `{ kind: "bytes", bytes: number[] }` payload — allocates a
 * 64-million-element JS array for a file at the cap, structured-clones it to the
 * Worker, and then `JSON.stringify`s it into a ~200 MB string. That is not slow;
 * it is an out-of-memory path with a size limit that says it should work.
 *
 * So the `File` HANDLE is what crosses to the Worker (`invokeWithFile`), the
 * Worker reads it, and `invoke_with_bytes` copies it into wasm once. The page
 * allocates nothing, which is a stronger property than chunking would have given
 * and a much smaller mechanism.
 *
 * The vault-side result is identical either way: same `attachment_import` core,
 * same 64 MiB cap, same MIME re-sniff of the actual bytes, same content-addressed
 * id — so a file imported here and the same file imported on desktop produce the
 * same `MYA1` blob.
 */
export async function importPicked(picked: PickedFile): Promise<ImportedAttachment> {
  const file = fileFor(picked);
  if (file === null) {
    // A handle this host did not mint means two hosts are installed at once —
    // a startup bug. Surfacing it as itself beats presenting it as a failed
    // import of a file that is perfectly fine.
    throw new Error("picked file was not minted by this host");
  }
  return await invokeWithFile<ImportedAttachment>(
    "plugin:attachments|attachment_import",
    // Everything EXCEPT the content. `filename` is a display label; the stored
    // content type is re-sniffed host-side and never taken from here.
    { filename: picked.name !== "" ? picked.name : null },
    file,
  );
}

/**
 * Turn a `File` from an HTML5 drop or clipboard paste into a picked handle.
 *
 * `nameOverride` carries the auto-generated name for a pasted screenshot, whose
 * `File.name` is empty — the editor decides that name (it owns the naming
 * convention), and this only needs to carry it.
 */
export function pickedFromDropped(file: File, nameOverride?: string): PickedFile | null {
  const picked = pickedFromFile(file);
  return nameOverride !== undefined && nameOverride !== ""
    ? { ...picked, name: nameOverride }
    : picked;
}

/**
 * A browser cannot reach a source a note merely NAMES.
 *
 * Always `null`, and that is the modelled answer rather than a gap: file access
 * requires a user gesture, so a path in a document is not openable no matter how
 * the call is shaped. The caller's fallback — offer the picker — is exactly what
 * a user needs here, so the import-and-convert flow works on web with no
 * web-specific branch anywhere in `@myne/editor`.
 */
export function resolveLiteralSource(_source: string): PickedFile | null {
  return null;
}
