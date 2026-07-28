// The host side of `@myne/editor`'s opaque picked-file handle
// (phase3-web-client task 76).
//
// # Why the seam stopped passing paths
//
// Every file-picking flow used to open a native dialog, receive an ABSOLUTE
// PATH STRING, and hand that string to a Rust command that did the read. A
// browser picker cannot produce a path — it produces a `File` — so a path-shaped
// seam is one of the few shapes that COMPILES on web and fails at runtime, which
// is exactly the failure mode `src/platform/` exists to convert into a modelled
// one.
//
// So `@myne/editor` now receives a `PickedFile` whose `handle` it never
// inspects, and the two sides of that opacity live here:
//
//   `pickedFromPath` mints one   ← this client, wrapping the dialog's path
//   `importSourceFor` unwraps it → the IPC payload the Rust side already takes
//
// # What deliberately did NOT change
//
// The wire. `importSourceFor` reconstructs `{ kind: "path", path }` verbatim, so
// `plugin:attachments|attachment_import`'s payload is byte-identical to what it
// received before this task. The bytes still never cross IPC on desktop: Rust
// opens the path inside its own root-confined read, which is both faster (no
// 64 MiB round trip through V8) and the reason the plaintext-IPC window stays
// as small as it is (`src-tauri/CLAUDE.md`, Plaintext-IPC pattern).
//
// A future web host mints the other kind — `handle` is the `File` — and
// `importSourceFor` grows a branch that streams it. That branch belongs to the
// web client, not here.

import type { PickedFile } from "@myne/editor";
import type { ImportSource } from "./attachments";

/** The desktop handle: the absolute path the native dialog returned. */
interface PathHandle {
  readonly kind: "path";
  readonly path: string;
}

/** Wrap an absolute path from the native dialog as an opaque picked file.
 *
 * `size` and `mimeHint` are `null` rather than probed: learning either would
 * take an extra `fs` capability for information nothing needs. The size cap is
 * enforced host-side during the import (a bounded prefix read, task 44), and the
 * content type is always re-sniffed from the decrypted bytes — a picker's
 * claimed MIME is never trusted (`protocol.md` §9.9).
 */
export function pickedFromPath(path: string): PickedFile {
  return {
    // The final path component. Only a display label — the Rust side derives
    // the stored filename from the path it reads, so this is not load-bearing.
    name: path.split(/[\\/]/).pop() ?? path,
    size: null,
    mimeHint: null,
    handle: { kind: "path", path } satisfies PathHandle,
  };
}

/**
 * The absolute path behind a desktop-minted handle (phase3-web-client task 71).
 *
 * Its one caller is `pickFileAsTree`, which needs the path as a `PickedTree.root`
 * — the string the host read seam validates against. Throws on a foreign handle
 * for the same reason {@link importSourceFor} does: it means two hosts are
 * installed at once, which is a startup bug and not something to paper over.
 */
export function pathOf(file: PickedFile): string {
  const handle = file.handle as Partial<PathHandle> | null;
  if (handle?.kind !== "path" || typeof handle.path !== "string") {
    throw new Error("picked file was not minted by this host");
  }
  return handle.path;
}

/** Turn a picked file back into the IPC import source.
 *
 * Throws on a handle this client did not mint. That is deliberate: a foreign
 * handle means two hosts are installed at once, which is a startup bug, and a
 * silent fallback would present it as a failed import instead.
 */
export function importSourceFor(file: PickedFile): ImportSource {
  const handle = file.handle as Partial<PathHandle> | null;
  if (handle?.kind !== "path" || typeof handle.path !== "string") {
    throw new Error("picked file was not minted by this host");
  }
  return { kind: "path", path: handle.path };
}
