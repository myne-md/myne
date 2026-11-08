#!/usr/bin/env node
// The three places the Arch packaging states a release version agree, and the
// from-source recipe builds a COMMIT rather than a mutable tag
// (myne-md/myne#758, security-audit lead NV11).
//
// # The two defects this prevents
//
// 1. **The version drifted and nothing compared it.** `packaging/arch/PKGBUILD`
//    (the from-source recipe) said `pkgver=0.5.0` while `tauri.conf.json` said
//    `0.8.0`, and at the time of the audit `myne-bin/PKGBUILD` and `flake.nix`
//    said `0.11.4` while the from-source one still said `0.11.3`: one stable
//    release behind, silently, because the release runbook's downstream-pin pass
//    names only the binary recipe. A stale from-source package is not a cosmetic
//    problem: `makepkg` derives the build's `git+…` ref from the recipe, so the
//    recipe decides what source a distribution user compiles, and nothing
//    anywhere said the three numbers had parted.
//
// 2. **The source ref was mutable.** `source=(… "git+…#tag=v$pkgver")` with
//    `sha256sums=('SKIP')` meant a moved tag rebuilds different bytes under the
//    same version, and there is no hash to notice it. makepkg cannot hash a git
//    checkout, so for a VCS source the REF is the integrity. A commit id is
//    content-addressed and cannot be moved, which is why `SKIP` is correct for
//    `#commit=<40 hex>` and wrong for a tag or for any non-git source.
//
// # Why `flake.nix` is the anchor
//
// The release version the Linux packages describe is the one `flake.nix` serves:
// it pins both AppImage URLs and their SRI hashes, and the release runbook
// requires it to move with them. It is in this repository, needs no network and
// no companion clone, so the comparison is available in `pre-commit` and in CI.
//
// Every failure names the file and the number, and an input this guard could not
// read is a failure rather than a pass. A guard that answers "fine" when its own
// regex missed is the failure mode this repository keeps rediscovering.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const FLAKE = "flake.nix";
export const SOURCE_PKGBUILD = "packaging/arch/PKGBUILD";
export const BINARY_PKGBUILD = "packaging/arch/myne-bin/PKGBUILD";

/** The version a PKGBUILD declares, or null when the line is missing. */
export function pkgverOf(text) {
  const m = text.match(/^pkgver=([0-9][0-9A-Za-z._]*)$/m);
  return m ? m[1] : null;
}

/** Every `v<X.Y.Z>` release version the flake's download URLs name. */
export function flakeReleaseVersions(text) {
  return [...new Set([...text.matchAll(/downloads\.myne\.md\/releases\/v([0-9]+\.[0-9]+\.[0-9]+)\//g)].map((m) => m[1]))];
}

/**
 * `{ ref, sha }` for a PKGBUILD's primary `source=(…)`: the ref fragment
 * (`commit=…` / `tag=…` / none) and its declared checksum.
 */
export function sourceRefOf(text) {
  const m = text.match(/^source=\((.*)\)$/m);
  if (!m) return { ref: null, kind: null, sums: [] };
  const refMatch = m[1].match(/#(commit|tag|branch)=([^\s"')]+)/);
  const sums = [...text.matchAll(/^sha256sums(?:_[A-Za-z0-9_]+)?=\('([^']*)'\)$/gm)].map((s) => s[1]);
  const isGit = /git\+/.test(m[1]);
  return {
    kind: isGit ? "git" : "archive",
    refKind: refMatch ? refMatch[1] : null,
    ref: refMatch ? refMatch[2] : null,
    sums,
  };
}

/** Pure over its inputs so `tests/scripts/` can inject each defect. */
export function audit({ flakeText, sourcePkgbuildText, binaryPkgbuildText }) {
  const failures = [];
  const fail = (msg) => failures.push(msg);

  const fromSource = pkgverOf(sourcePkgbuildText);
  const binary = pkgverOf(binaryPkgbuildText);
  const flakeVersions = flakeReleaseVersions(flakeText);

  if (!fromSource) fail(`${SOURCE_PKGBUILD}: no \`pkgver=\` line.`);
  if (!binary) fail(`${BINARY_PKGBUILD}: no \`pkgver=\` line.`);
  if (flakeVersions.length === 0) {
    fail(
      `${FLAKE}: no \`downloads.myne.md/releases/v<X.Y.Z>/\` URL. That URL is the anchor the ` +
        "Arch recipes are compared against, so a flake that names no release leaves this guard " +
        "unable to see the drift it exists for.",
    );
  }
  if (flakeVersions.length > 1) {
    fail(
      `${FLAKE}: names more than one release version (${flakeVersions.join(", ")}). Both ` +
        "architecture URLs move together by the release runbook, so a file carrying two means " +
        "one arm was missed.",
    );
  }

  if (fromSource && binary && fromSource !== binary) {
    fail(
      `${SOURCE_PKGBUILD} says pkgver=${fromSource} and ${BINARY_PKGBUILD} says ` +
        `pkgver=${binary}. They are one release stated twice; bump both in the same pass ` +
        "(the release runbook's downstream-pin phase).",
    );
  }
  if (flakeVersions.length === 1) {
    for (const [rel, ver] of [
      [SOURCE_PKGBUILD, fromSource],
      [BINARY_PKGBUILD, binary],
    ]) {
      if (ver && ver !== flakeVersions[0]) {
        fail(
          `${rel} says pkgver=${ver} but ${FLAKE} serves v${flakeVersions[0]}. A recipe left ` +
            "behind the release builds and installs an older version than every other Linux " +
            "package of the same release.",
        );
      }
    }
  }

  // ── The source ref ────────────────────────────────────────────────────────
  const src = sourceRefOf(sourcePkgbuildText);
  if (src.kind === null) {
    fail(`${SOURCE_PKGBUILD}: no \`source=(…)\` line, so the build has no pinned input.`);
  } else if (src.kind === "git") {
    if (src.refKind !== "commit") {
      fail(
        `${SOURCE_PKGBUILD}: the git source refs \`${src.refKind ?? "(nothing)"}\` rather than ` +
          "`#commit=`. A tag or branch can be moved, so the recipe would build different sources " +
          "under the same version with no hash able to notice (myne-md/myne#758, NV11).",
      );
    } else if (!/^[0-9a-f]{40}$/.test(src.ref)) {
      fail(
        `${SOURCE_PKGBUILD}: \`#commit=${src.ref}\` is not a full 40-character lowercase sha. ` +
          "Short hashes are ambiguous, and a symbolic or abbreviated pin is what the tag form " +
          "already was.",
      );
    }
  }

  // `sha256sums=('SKIP')` is only defensible where the ref IS the integrity: a
  // git source pinned to a commit. Anywhere else it is an unverified download.
  const skips = src.sums.filter((s) => s === "SKIP");
  if (skips.length > 0) {
    const commitPinned = src.kind === "git" && src.refKind === "commit" && /^[0-9a-f]{40}$/.test(src.ref ?? "");
    if (!commitPinned) {
      fail(
        `${SOURCE_PKGBUILD}: \`sha256sums=('SKIP')\` on a source that is not a commit-pinned git ` +
          "checkout. For a VCS source the commit is the integrity check; for anything else SKIP " +
          "means nothing verified the download.",
      );
    }
  }

  return failures;
}

function main() {
  const read = (rel) => {
    const p = join(ROOT, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  const texts = {
    flakeText: read(FLAKE),
    sourcePkgbuildText: read(SOURCE_PKGBUILD),
    binaryPkgbuildText: read(BINARY_PKGBUILD),
  };
  for (const [key, rel] of [
    ["flakeText", FLAKE],
    ["sourcePkgbuildText", SOURCE_PKGBUILD],
    ["binaryPkgbuildText", BINARY_PKGBUILD],
  ]) {
    if (texts[key] === null) {
      process.stderr.write(`check-arch-pkgbuild: ${rel} is missing.\n`);
      process.exit(1);
    }
  }

  const failures = audit(texts);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`check-arch-pkgbuild: ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `check-arch-pkgbuild: ok, v${pkgverOf(texts.sourcePkgbuildText)} across both recipes and ${FLAKE}, ` +
      "commit-pinned source\n",
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
