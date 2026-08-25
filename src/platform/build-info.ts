// Platform seam — which build is this, exactly? (phase3-web-client task 114)
//
// # Why the bundle hash cannot be a compile-time define
//
// The obvious design is `__BUNDLE_HASH__` beside `__APP_VERSION__`. It does not
// work, and the reason is not an implementation detail: **a bundle cannot
// contain its own hash.** Writing the hash into the bytes changes the bytes, so
// the value would describe a build that no longer exists. `scripts/emit-web-version.mjs`
// computes it AFTER the build and writes `web/dist/version.json` for exactly
// that reason.
//
// So the version and the commit are compile-time (they are inputs, not outputs)
// and the hash is FETCHED, same-origin, from the document the deploy already
// publishes — the same one the post-deploy smoke gate reads and the same one
// anyone can `curl`. Comparing it against the record of released hashes is a
// different matter: that record is in a private repository today, so a user
// cannot look their hash up in it (docs/threat-model.md §5, entry 0534). The
// value is still worth serving, because quoting it lets someone with access
// settle the question.
//
// # Why desktop answers `null` rather than something
//
// There is no served bundle to identify. A desktop user's build identity is the
// installer they ran, which the version string already names. And
// inventing a per-install hash here would be a number that means nothing and
// looks like it means something.
//
// # What this is NOT
//
// Not a security claim. The hash is a build-identity readout presented exactly
// as the version string is, with no accompanying warning about the weakened
// trust posture — that disclosure is a separate, deliberate decision and is out
// of this task's scope. And nothing here is transmitted: `version.json` is
// same-origin, `no-store`, and read only when a user opens About.

/** The build-identity fields a client can state about itself. */
export interface BuildInfo {
  /** SHA-256 of the served bundle, e.g. `sha256:03ef…`. */
  readonly bundleHash: string;
  /** The commit the bundle was built from. */
  readonly commit: string;
}

/**
 * The served bundle's identity, or `null` where there is no served bundle.
 *
 * Desktop: always `null` — see the header.
 */
export async function servedBuildInfo(): Promise<BuildInfo | null> {
  return null;
}
