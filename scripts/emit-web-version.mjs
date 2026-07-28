#!/usr/bin/env node
// Emit `web/dist/version.json` — the build-info document (phase3-web-client
// task 111).
//
// What it is for: making a deploy observable without downloading and hashing a
// bundle by hand. The post-deploy smoke gate reads it (task 112), the About
// surface displays the same triple (task 114), and anyone can compare a running
// instance against the published hash record (task 56) with one `curl`.
//
// What it deliberately does NOT carry: anything account-specific, and any
// counter. A "requests served" or "users online" field would be telemetry with
// a different name, and this origin's whole posture is that it keeps no such
// record.
//
// Served with `Cache-Control: no-store` and excluded from the service worker's
// pinned cache, so it always describes the **served** build rather than the
// installed one — otherwise a client pinned to an old bundle would report the
// new build's identity and the smoke gate would pass against a stale deploy.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIST = process.argv[2] ?? "web/dist";
if (!existsSync(DIST)) {
  console.error(`emit-web-version: no bundle at ${DIST} — run \`pnpm web:build\` first.`);
  process.exit(2);
}

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Hash of the bundle, not of one file: every emitted asset, in sorted order,
 * each contributing its path and its content. Sorted so the hash does not
 * depend on directory-read order, and path-inclusive so a rename is a change.
 *
 * `version.json` and `assets-manifest.json` are excluded — both contain the
 * hash or are derived from it, so including them would be circular.
 */
const DERIVED = new Set(["version.json", "assets-manifest.json"]);

/**
 * OS detritus that is not part of the bundle and must not reach the hash.
 *
 * Found by the manifest, which listed `.DS_Store` as an asset: Finder writes it
 * into any directory it has been looked at, so a bundle hashed on a machine
 * where someone opened `web/dist` differed from the same commit built anywhere
 * else. The container build never had it (`.dockerignore`), so the published
 * hashes were right — but "the same commit produces the same hash" was only
 * true by accident of where the build ran, which is exactly the property the
 * record depends on.
 */
const OS_DETRITUS = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** Every emitted asset, sorted, as `[relative-path, absolute-path]`. */
function emittedFiles(dir) {
  const files = [];
  (function walk(d, rel) {
    for (const name of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, name.name);
      const r = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) walk(p, r);
      else if (!DERIVED.has(r) && !OS_DETRITUS.has(name.name)) files.push([r, p]);
    }
  })(dir, "");
  return files;
}

function bundleHash(dir) {
  const h = createHash("sha256");
  for (const [rel, abs] of emittedFiles(dir)) {
    h.update(rel, "utf8");
    h.update("\0");
    h.update(readFileSync(abs));
  }
  return h.digest("hex");
}

/**
 * Per-asset digests — the shape a signed-manifest scheme expects
 * (phase3-web-client task 57).
 *
 * The bundle hash above is one number over everything: it answers "is this the
 * published bundle" and nothing finer. A signed manifest needs to answer "is
 * THIS FILE the one that was signed", per request, which is a different
 * question and needs a different document. Emitting it now is what makes
 * adopting such a scheme later a matter of signing this file rather than
 * restructuring the build.
 *
 * Deliberately NOT signed here. Signing keys never live in CI (the
 * build-vs-sign separation), so a manifest this script signed would either
 * carry a key CI holds — which is the thing that separation forbids — or a
 * placeholder signature, which is worse than none.
 */
function assetsManifest(dir) {
  const assets = {};
  for (const [rel, abs] of emittedFiles(dir)) {
    assets[rel] = "sha256:" + createHash("sha256").update(readFileSync(abs)).digest("hex");
  }
  return assets;
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
// Env first, git second. The container build has no `.git` at all — it is
// excluded from the build context — so inside the image git answers nothing and
// both fields would read `unknown`, which would make the post-deploy smoke gate
// unable to tell a fresh deploy from a stale one (task 112). The values passed
// in are still the COMMIT's identity and the COMMIT's timestamp, never a wall
// clock, so the reproducibility property below is unchanged.
const info = {
  version: pkg.version,
  commit: process.env.MYNE_BUILD_COMMIT || git("rev-parse", "HEAD") || "unknown",
  // The commit's own timestamp, not `Date.now()`: a reproducible build must
  // produce a byte-identical `version.json` for a given commit, and a wall-clock
  // stamp would make every rebuild differ (task 16).
  built_at:
    process.env.MYNE_BUILD_TIMESTAMP || git("show", "-s", "--format=%cI", "HEAD") || "unknown",
  bundle_hash: `sha256:${bundleHash(DIST)}`,
};

writeFileSync(join(DIST, "version.json"), JSON.stringify(info, null, 2) + "\n");

// The per-asset manifest, beside the bundle it describes. Same commit identity
// so a reader can tell at a glance which build it belongs to.
const manifest = {
  version: info.version,
  commit: info.commit,
  built_at: info.built_at,
  bundle_hash: info.bundle_hash,
  assets: assetsManifest(DIST),
};
writeFileSync(join(DIST, "assets-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `emit-web-version: ${info.bundle_hash} (${info.commit.slice(0, 8)}), ` +
    `${Object.keys(manifest.assets).length} assets manifested`,
);
