// Platform seam — choosing files, as an opaque handle rather than a path
// (phase3-web-client task 76).
//
// # Why this is not `platform/dialog.open`
//
// It nearly was. `dialog.open` already exists on both sides of the seam, and
// reaching for it here is the obvious move — but the web implementation's own
// header says why it is the wrong one: a browser "deliberately never gives a
// page" a path, so `web/src/platform/dialog.ts` resolves the picked file's
// NAME, and warns that "a caller that takes the result and hands it to something
// expecting a real filesystem path is broken on web no matter what this
// returns".
//
// Every attachment / theme / import flow was exactly that caller. So the fix is
// not a better `open()`; it is a seam whose RESULT TYPE cannot be mistaken for a
// path. `PickedFile` carries a name, an optional size, a MIME hint and a
// host-private `handle` — and `@myne/editor` reads only the first three.
//
// `dialog.open` stays where it is, for the flows that genuinely want a location
// string (choosing an export directory), and this file is what the flows that
// want BYTES use.

import { open } from "./dialog";
import { unsupported } from "./unsupported";
import { pickedFromPath, importSourceFor, pathOf } from "../lib/picked-file";
import { attachmentImport, type ImportedAttachment } from "../lib/attachments";
import type { PickedFile } from "@myne/editor";

/** What to offer in the picker. Extension filters are a HINT — the user can
 *  still choose anything, and the import path accepts any bytes since
 *  MYND-173. */
export interface PickFilesOptions {
  readonly multiple?: boolean;
  readonly extensions?: readonly string[];
  /** Already-localized label for the extension filter group. */
  readonly filterLabel?: string;
}

/**
 * Open the platform's file picker. Resolves `null` on cancel.
 *
 * Desktop: the native dialog, whose absolute paths are wrapped as opaque
 * handles. Nothing above this line ever sees one, and the Rust side still does
 * the read inside its own root-confined seam — so the bytes never make a 64 MiB
 * round trip through V8.
 */
export async function pickFiles(opts?: PickFilesOptions): Promise<PickedFile[] | null> {
  const filters =
    opts?.extensions !== undefined && opts.extensions.length > 0
      ? [{ name: opts.filterLabel ?? "", extensions: [...opts.extensions] }]
      : undefined;

  const picked = await open({
    multiple: opts?.multiple ?? false,
    directory: false,
    ...(filters !== undefined ? { filters } : {}),
  });
  if (picked === null) return null;

  const paths = Array.isArray(picked) ? picked : [picked];
  return paths.map(pickedFromPath);
}

/**
 * One file inside a picked directory (phase3-web-client task 71).
 *
 * `path` is relative to the picked root, POSIX-separated, with no leading slash
 * and no root segment — `notes/daily/2026-07-27.md`. Relative rather than
 * absolute because that is the only form BOTH platforms can produce: a browser
 * gives `webkitRelativePath` and has no path at all, and the importer's folder
 * mapping is relative-shaped anyway.
 */
export interface PickedTreeEntry {
  readonly path: string;
  readonly file: PickedFile;
}

/**
 * A picked directory, in the one shape both platforms can answer.
 *
 * The asymmetry in `entries` is the honest one and is not a gap:
 *
 * * **Desktop** returns `null`. The host walks the tree itself inside the
 *   root-confined `importer:` read seam (`src-tauri/src/plugins/importer/`),
 *   which is the least-privilege arrangement the WebView deliberately does not
 *   have — every read is canonicalised and checked within-root host-side. Handing
 *   the page a pre-walked list would mean granting the WebView the directory read
 *   this seam exists to withhold.
 * * **Web** returns the list, because the browser already did the walk: the
 *   picker's own result IS the tree, and there is no host to ask. Nothing is
 *   widened by it — a page cannot see a byte the user did not hand it.
 *
 * So a consumer branches on `entries === null` to choose between "ask the host"
 * and "read what I was given", and both branches are correct on their platform
 * rather than one being a degraded copy of the other.
 */
export interface PickedTree {
  /** The picked root. Desktop: the absolute path its read seam validates
   *  against. Web: the folder's own NAME — a browser never gives a path, and
   *  this is used for display and as the media-index prefix, never opened. */
  readonly root: string;
  readonly entries: readonly PickedTreeEntry[] | null;
}

/**
 * Open the platform's DIRECTORY picker. Resolves `null` on cancel.
 *
 * Beside `pickFiles` rather than an option on it because the results are
 * different types, and a boolean that changes a return type is how a caller ends
 * up handling one shape and being handed the other.
 */
export async function pickDirectory(): Promise<PickedTree | null> {
  const picked = await open({ multiple: false, directory: true });
  if (picked === null) return null;
  const root = Array.isArray(picked) ? picked[0] : picked;
  if (root === undefined) return null;
  return { root, entries: null };
}

/**
 * Open the platform's FILE picker and return the result as a one-entry
 * {@link PickedTree} (phase3-web-client task 71).
 *
 * The single-file import sources (Evernote `.enex`, CSV) run through the same
 * adapters as the tree ones, calling `readFile(root)` with the root itself. So
 * they need the same TYPE, not a second code path — this is what lets the modal
 * hold one `PickedTree | null` for every source instead of a union it would have
 * to re-branch on at each use.
 *
 * Desktop keeps `entries: null` for the same reason the directory arm does: the
 * host reads the file inside its within-root seam, where root and target are the
 * same path and the check trivially holds.
 */
export async function pickFileAsTree(opts?: PickFilesOptions): Promise<PickedTree | null> {
  const picked = await pickFiles({ ...opts, multiple: false });
  const first = picked?.[0];
  if (first === undefined) return null;
  return { root: pathOf(first), entries: null };
}

/**
 * Read a picked file's UTF-8 text (phase3-web-client task 71).
 *
 * **A typed refusal on desktop, and it is unreachable there by construction.**
 * Its one consumer is the tree-backed importer ports, which exist only on the
 * `entries !== null` branch of {@link PickedTree} — the branch desktop never
 * produces, because its host walks and reads the tree inside the root-confined
 * `importer:` read seam. A desktop implementation here would be a SECOND, wider
 * read path for the same bytes: this one takes an opaque handle with no
 * within-root check, which is exactly what that seam exists to withhold.
 *
 * So the refusal is the design, in the same shape as `pickedFromDropped`'s
 * `null` — the platform that cannot honestly do the thing says so in a type
 * rather than doing something adjacent.
 */
export async function readPickedText(file: PickedFile): Promise<string> {
  void file;
  return unsupported("filePicker.readPickedText");
}

/**
 * Read a picked SMALL text file (a theme `.json`), on either platform (#262).
 *
 * Distinct from {@link readPickedText}, which desktop refuses on purpose: a
 * general "read this path as text" would hand the WebView an unbounded read
 * outside the root-confined seam. This one is narrow by construction — it goes
 * through the importer's existing root-confined `import_read_file`, the same
 * call the theme importer already used, and only its ARGUMENT shape changes.
 *
 * It exists because the custom-theme import was never ported: the picker was
 * `dialog.open` (a typed refusal in the browser), so a user on web who picked a
 * perfectly valid theme file got "not a valid theme". Its export twin branched
 * on the capability; the import side did not.
 */
export async function readPickedSmallText(file: PickedFile): Promise<string> {
  const path = pathOf(file);
  if (path === null) {
    // The desktop seam only ever mints path handles. Anything else means the
    // caller crossed platforms with a value this arm cannot honour.
    return unsupported("filePicker.readPickedSmallText");
  }
  const { importReadFile } = await import("../notes/import/ports");
  const { splitExportPath } = await import("../notes/exportFlow");
  return importReadFile(splitExportPath(path).dir, path);
}

/**
 * Import a picked file into the vault (phase3-web-client task 67).
 *
 * # Why the seam owns the IMPORT and not just the handle
 *
 * The unwrap used to live in `src/lib/picked-file.ts`, outside the seam, and it
 * THREW for any handle this client did not mint — which meant the web client
 * could pick a file and then fail on every import, since its handle is a `File`.
 * The reason it could not simply grow a branch there is that the two platforms
 * do not differ in the *shape* of the payload, they differ in **who reads the
 * bytes**: desktop hands Rust a path and Rust opens it inside its root-confined
 * seam (nothing crosses IPC), while a browser has no path and must move the
 * content itself. Only the platform can answer that, so the platform owns the
 * whole call.
 *
 * Desktop: `{ kind: "path" }`, byte-identical to the payload before this task —
 * up to 64 MiB still never crosses IPC.
 */
export async function importPicked(file: PickedFile): Promise<ImportedAttachment> {
  return await attachmentImport(importSourceFor(file));
}

/**
 * Turn a `File` from an HTML5 drop or clipboard paste into a picked handle, or
 * `null` where the platform has no use for one.
 *
 * **`null` on desktop, deliberately.** A `File` from a WebView `DataTransfer`
 * has no path, so a desktop handle cannot be minted from one and the editor's
 * existing bytes path stays exactly as it was — the criterion "desktop OS-drop
 * path unaffected", enforced by there being nothing to affect.
 */
export function pickedFromDropped(file: File, nameOverride?: string): PickedFile | null {
  void file;
  void nameOverride;
  return null;
}

/**
 * Wrap a source string a note NAMES (`![](…/pic.png)`) as a picked file, or
 * `null` where this platform cannot reach an arbitrary source.
 *
 * Desktop can: the path is opened by the import itself, which is also the
 * existence test — so this adds no `fs` capability. A browser cannot open
 * anything it was not handed by a user gesture, and its implementation returns
 * `null`, which routes the caller straight to the picker.
 */
export function resolveLiteralSource(source: string): PickedFile | null {
  return pickedFromPath(source);
}
