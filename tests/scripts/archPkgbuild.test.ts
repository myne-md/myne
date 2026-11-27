// Injection tests for `check-arch-pkgbuild.mjs` (myne-md/myne#758, NV11).
//
// The lead was two defects in one file: `pkgver=0.5.0` against `tauri.conf.json`'s
// `0.8.0` with nothing comparing the two, and a `#tag=v$pkgver` source with
// `sha256sums=('SKIP')` so a moved tag rebuilds different bytes under the same
// version. Neither is visible to a compiler, and a recipe that is one release
// behind still builds. It just builds the wrong release.
//
// Each case below is one way that comes back. The guard is pure over
// `{ flakeText, sourcePkgbuildText, binaryPkgbuildText }` for exactly this reason.

import { describe, expect, it } from "vitest";
import {
  audit,
  flakeReleaseVersions,
  pkgverOf,
  sourceRefOf,
} from "../../scripts/check-arch-pkgbuild.mjs";

const FLAKE = [
  "{",
  '  description = "Myne";',
  "      srcFor = system: pkgs:",
  '        url = "https://downloads.myne.md/releases/v0.11.4/Myne_0.11.4_amd64.AppImage";',
  '        url = "https://downloads.myne.md/releases/v0.11.4/Myne_0.11.4_aarch64.AppImage";',
  "}",
].join("\n");

const pkgbuild = ({ pkgver = "0.11.4", ref = "#commit=" + "a".repeat(40), sums = "('SKIP')", git = true } = {}) =>
  [
    "pkgname=myne",
    `pkgver=${pkgver}`,
    "pkgrel=1",
    `source=("$pkgname::git+https://github.com/myne-md/myne.git${ref}")`,
    `sha256sums=${sums}`,
    "",
  ]
    .join("\n")
    .replaceAll("git+", git ? "git+" : "");

const BINARY = ["pkgname=myne-bin", "pkgver=0.11.4", "pkgrel=1", ""].join("\n");

const run = (over = {}) =>
  audit({
    flakeText: FLAKE,
    packageJsonText: null,
    sourcePkgbuildText: pkgbuild(),
    binaryPkgbuildText: BINARY,
    ...over,
  });

describe("the parsers", () => {
  it("reads a pkgver and the flake's release versions", () => {
    expect(pkgverOf(pkgbuild())).toBe("0.11.4");
    expect(flakeReleaseVersions(FLAKE)).toEqual(["0.11.4"]);
  });

  it("reads a commit ref and its SKIP", () => {
    const src = sourceRefOf(pkgbuild());
    expect(src.kind).toBe("git");
    expect(src.refKind).toBe("commit");
    expect(src.sums).toEqual(["SKIP"]);
  });
});

describe("the tree's current shape passes", () => {
  it("reports no failures", () => {
    expect(run()).toEqual([]);
  });
});

describe("the version drift the lead found", () => {
  it("names a from-source recipe behind the binary recipe", () => {
    const failures = run({ sourcePkgbuildText: pkgbuild({ pkgver: "0.11.3" }) });
    const drift = failures.filter((f) => f.includes("one release stated twice"));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("pkgver=0.11.3");
    expect(drift[0]).toContain("pkgver=0.11.4");
  });

  it("names a recipe behind the release the flake serves", () => {
    const failures = run({ binaryPkgbuildText: ["pkgname=myne-bin", "pkgver=0.9.0", ""].join("\n") });
    const behind = failures.filter((f) => f.includes("flake.nix serves v0.11.4"));
    expect(behind).toHaveLength(1);
    expect(behind[0]).toContain("packaging/arch/myne-bin/PKGBUILD says pkgver=0.9.0");
  });

  it("names a flake that serves two different releases", () => {
    const failures = run({ flakeText: FLAKE.replace("v0.11.4/Myne_0.11.4_aarch64", "v0.10.0/Myne_0.10.0_aarch64") });
    const twoVersions = failures.filter((f) => f.includes("names more than one release version"));
    expect(twoVersions).toHaveLength(1);
    expect(twoVersions[0]).toContain("0.11.4, 0.10.0");
  });

  it("fails when the flake names no release at all", () => {
    const failures = run({ flakeText: "{ description = \"Myne\"; }\n" });
    expect(failures.some((f) => f.includes("leaves this guard unable to see the drift"))).toBe(true);
  });
});

describe("the mutable source ref the lead found", () => {
  it("names a tag ref, which can be moved", () => {
    const failures = run({ sourcePkgbuildText: pkgbuild({ ref: "#tag=v$pkgver" }) });
    const tagRef = failures.filter((f) => f.includes("rather than `#commit=`"));
    expect(tagRef).toHaveLength(1);
    expect(tagRef[0]).toContain("tag");
  });

  it("names a short commit as ambiguous", () => {
    const failures = run({ sourcePkgbuildText: pkgbuild({ ref: "#commit=2a40fe40" }) });
    expect(failures.some((f) => f.includes("not a full 40-character lowercase sha"))).toBe(true);
  });

  it("names an uppercase commit, which is not the same string", () => {
    const failures = run({ sourcePkgbuildText: pkgbuild({ ref: "#commit=" + "A".repeat(40) }) });
    expect(failures.some((f) => f.includes("not a full 40-character lowercase sha"))).toBe(true);
  });

  it("refuses SKIP on a source that is not a commit-pinned git checkout", () => {
    const failures = run({
      sourcePkgbuildText: pkgbuild({ git: false, ref: "", sums: "('SKIP')" }),
    });
    expect(failures.some((f) => f.includes("nothing verified the download"))).toBe(true);
  });

  it("refuses SKIP on a git source pinned to a tag", () => {
    const failures = run({ sourcePkgbuildText: pkgbuild({ ref: "#tag=v$pkgver" }) });
    expect(failures.some((f) => f.includes("nothing verified the download"))).toBe(true);
  });

  it("accepts a real checksum on an archive source", () => {
    const archive = [
      "pkgname=myne",
      "pkgver=0.11.4",
      'source=("https://downloads.myne.md/releases/v0.11.4/Myne_0.11.4_amd64.AppImage")',
      `sha256sums=('${"c".repeat(64)}')`,
      "",
    ].join("\n");
    expect(run({ sourcePkgbuildText: archive })).toEqual([]);
  });
});

describe("an input the guard could not read is a failure", () => {
  it("fails when a PKGBUILD has no pkgver", () => {
    const failures = run({ sourcePkgbuildText: "pkgname=myne\n" });
    expect(failures.some((f) => f.includes("no `pkgver=` line"))).toBe(true);
  });

  it("fails when the source line is gone", () => {
    const failures = run({ sourcePkgbuildText: "pkgname=myne\npkgver=0.11.4\n" });
    expect(failures.some((f) => f.includes("no `source=(…)` line"))).toBe(true);
  });
});
