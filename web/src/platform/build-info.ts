// The web arm of the build-identity seam (phase3-web-client task 114).
//
// See `src/platform/build-info.ts` for why the hash is fetched rather than
// compiled in: a bundle cannot contain its own hash, so `emit-web-version.mjs`
// computes it after the build and publishes `version.json` beside the bundle.
//
// # Why this is worth having at all
//
// The web bundle is re-delivered on every load, is meant to be pinned by a
// service worker (task 54) and checkable against a published hash record (tasks
// 16 / 56) — **and none of that is usable if the client will not say which
// bundle it is running.** A user who wants to check, or a maintainer reading a
// bug report, needs the running instance to name itself.
//
// # Same-origin, `no-store`, user-initiated
//
// `/version.json` is served from the app origin, so this issues no cross-origin
// request and task 60's zero-third-party assertion is unaffected. `no-store`
// because the point is the SERVED build, not a cached description of an older
// one — a client pinned to an old bundle reporting the new build's identity
// would make the smoke gate pass against a stale deploy.
//
// Failure is `null`, not a throw: About is a settings panel, and a missing
// build document is a deployment gap rather than something the user did.

import type { BuildInfo } from "../../../src/platform/build-info";

export type { BuildInfo };

export async function servedBuildInfo(): Promise<BuildInfo | null> {
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) return null;
    const doc = (await res.json()) as { bundle_hash?: unknown; commit?: unknown };
    // Validated field by field rather than cast: this document is fetched at
    // runtime and rendered, so a malformed one must produce "unknown" rather
    // than `[object Object]` in a panel the user is reading to report a bug.
    const bundleHash = typeof doc.bundle_hash === "string" ? doc.bundle_hash : null;
    const commit = typeof doc.commit === "string" ? doc.commit : null;
    if (bundleHash === null || commit === null) return null;
    return { bundleHash, commit };
  } catch {
    return null;
  }
}
