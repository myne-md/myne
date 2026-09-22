// Platform seam: the plaintext export destination, and the WebView half of the
// mobile export chokepoint (`docs/glossary.md`, **export chokepoint**).
//
// Not a re-export of `@tauri-apps/api/path`. This file used to be
// `export { documentDir, join } from "@tauri-apps/api/path";` and four export
// flows each did `join(await documentDir(), name)`, then relied on a startup
// hook having excluded that directory from the platform's automatic cloud
// backup. `exportPath()` replaced it in myne#517: one call into the host that
// resolves the directory, creates it, applies the exclusion and sanitizes the
// name, and hands back a destination only when all four succeeded. That one
// call is the chokepoint; this file is the only way to reach it from
// `mobile/src`.
//
// Three things changed shape, and each of them was a place the answer could
// drift:
//
//   1. **The destination is the host's answer, not the WebView's.** Nothing
//      under `mobile/src` composes a path any more, so a new export flow cannot
//      reach for a sibling accessor (`downloadDir()`, `pictureDir()`) that no
//      exclusion covers. The whole `core:path:` namespace was dropped from
//      `capabilities/default.json` in the same change, so `plugin:path|*` is not
//      merely unused, it is unreachable.
//   2. **The path-traversal sanitizer is one function.** It was hand-rolled
//      twice in TypeScript (`EditorFlow.tsx`, `editor-host.ts`), absent in the
//      other two flows because their names are fixed, and now lives once in
//      `plugins/export_dir/mod.rs`, which re-checks the path it built rather
//      than trusting its own string rules.
//   3. **The exclusion is applied before the caller holds a path.** Ordering, not
//      a promise about a startup hook: see `backup_exclude::ensure_with` and the
//      test that asserts it.
//
// `documentDir`, not desktop's `appDataDir`: the two clients address different
// directories on purpose. Mobile writes user-visible exports into the Documents
// container; the desktop's equivalent is its app-data directory. The seam names
// what its own host is asked for rather than mirroring the other client's
// member list.
//
// **This comment used to call that container "the one iOS surfaces in Files and
// Android exposes to the share sheet", and both halves were wrong** (myne#491).
// iOS declares no `UIFileSharingEnabled`, so the directory is invisible in the
// Files app there and the share sheet is the user's only route to a file in it.
// Android is the platform with no share sheet (`share_file.rs::present` is a
// documented no-op, myne#505), and its copy of the directory is
// `Android/data/<pkg>/files/Documents`, which the system Files app has refused
// to navigate into since Android 11 (API 30) while `minSdk` here is 24.
//
// The correction matters at THIS file rather than only at the call sites,
// because this is where a future export flow reads what the directory is.
//
// One thing myne#517 did NOT make unrepresentable, stated so nobody deletes the
// guard that catches it: `scripts/check-platform-seam.mjs` permits this
// directory to import `@tauri-apps/api/path`, so re-adding a raw accessor here
// would compile and ship. `scripts/check-mobile-export-backup.mjs` rule 0 is
// what refuses it, and it refuses `documentDir` too, because reaching for the
// directory directly is how a flow gets past the sanitizer and the ordering
// above.
//
// And the chokepoint is NOT a containment boundary, which the name invites:
// the three export commands still take a caller-supplied path string and the
// note PDF reaches the host as an event payload, so containment stays with the
// writers (`threat-model.md` TB3's plaintext-egress exception). What it gives
// is the only way to obtain an export directory guaranteed to exist and to be
// excluded.
//
// See `./core.ts` for why this tree has a seam.

import { invoke } from "./core";

/** Where an export is about to go, as the host resolved it. */
export interface ExportDestination {
  /** The absolute destination: a direct child of the export directory. */
  path: string;
  /**
   * The export directory's display NAME (`Documents`), for a message that tells
   * the user where the file went. Not the absolute path, which is useless in a
   * sentence, and not a string spelled out at the call site, which is how a
   * label goes on naming a directory the export stopped using.
   */
  dir: string;
  /**
   * The basename the host actually used, AFTER sanitizing. Build labels from
   * this rather than from the argument you passed in: the two are different
   * whenever the name carried a separator or leading dots, and a label built
   * from the argument names a file that does not exist.
   */
  name: string;
}

/**
 * Resolve the destination a plaintext export writes to.
 *
 * `filename` is a single path component, not a path: the file a flow is about to
 * write, or (for the whole-vault markdown export) the directory the backend is
 * about to stage and publish. Separators and leading dots are stripped
 * host-side, so an attachment or note title carrying `../` cannot address
 * anything outside the export directory, and any extension survives that
 * stripping rather than being eaten by it.
 *
 * `fallback` is your own default STEM for the case where the name sanitizes away
 * entirely, sanitized on the same terms. Pass one whenever the name comes from
 * the user or from a note's own text: an attachment renamed to `..` is
 * reachable through the ordinary rename prompt, and without a fallback that
 * attachment can never be exported. Omit it when the name is a literal this file
 * controls, and the call then fails rather than inventing a name.
 *
 * Rejects when the backup exclusion does not read back as set, which is the
 * point of routing through the host at all: the export fails rather than landing
 * in a directory the platform would copy to its cloud.
 */
export function exportPath(filename: string, fallback?: string): Promise<ExportDestination> {
  return invoke<ExportDestination>("plugin:export-dir|export_path", { filename, fallback });
}
