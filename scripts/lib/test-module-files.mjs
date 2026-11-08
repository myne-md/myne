// A `#[cfg(test)]` module may live in its own file, wired from the file that owns
// it as:
//
//     #[cfg(test)]
//     #[path = "orchestrator_tests.rs"]
//     mod tests;
//
// None of those bytes reaches a build, so the production ratchets - the io seam,
// the task seam, version routing, the crypto registries - must not read the file
// as a new production site. They cannot see the `#[path]` declaration, because it
// sits in a DIFFERENT file: each of them walks one file at a time.
//
// So the `_tests.rs` suffix is the marker, and it is a convention rather than a
// guess: it is what every extracted test module in this tree is called. A guard
// that instead wants to be exact can resolve the declaration itself, which is what
// `core/src/plugins/sync/no_bypass.rs` does for the socket scan - it reads every
// file in its directory and only skips a module whose `#[path]` it saw under a
// `test` cfg. That is affordable for one directory and not for a repo-wide walk.

/**
 * True when `relPath` is a `#[cfg(test)]` module extracted into its own file.
 * `relPath` may be relative or absolute; only the basename is read.
 */
export function isExtractedTestModule(relPath) {
  const base = String(relPath).split(/[\\/]/).pop() ?? "";
  return /_tests\.rs$/.test(base);
}
