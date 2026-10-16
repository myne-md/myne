#!/usr/bin/env node
// The F-Droid store metadata against the Android build it describes.
//
// # The failure this exists for
//
// An F-Droid store page is assembled from three things that are written by hand
// in three different files, and the join between them is arithmetic:
//
//   1. `mobile/src-tauri/tauri.conf.json`'s `version` — the one file the Android
//      build actually consumes.
//   2. `mobile/fdroid/md.myne.mobile.yml` — four build blocks, one per ABI, each
//      declaring a `versionName`, a `versionCode` and a `sed` that changes the
//      generated gradle's versionCode by `* 10 + <digit>`.
//   3. `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` — and the
//      file name has to equal the FINAL per-ABI versionCode, not the semver.
//
// Nothing in the tree compares them. Bump `version` and the changelog files keep
// the old names, the recipe keeps the old codes, and every compiler, every test
// and every other guard here prints green. What it costs is invisible until the
// store page is live and empty: F-Droid resolves a changelog per version entry
// and a missing file is not an error, it is a blank "What's new" tab, and four
// build blocks sharing one versionCode means three architectures are silently
// dropped from the repository because a client only ever installs the highest
// code it can run.
//
// This is the same class as `check-desktop-payload-budget.mjs`'s models/* set
// and `check-embed-layout-drift.mjs`'s shared bound: two numbers that must agree,
// with no compiler and no test able to see it.
//
// # The version is NOT pinned, deliberately
//
// The guard derives the expected versionCodes from whatever `tauri.conf.json`
// says. It therefore has no opinion about WHICH release goes to F-Droid first,
// only that the three artefacts agree about it. Changing the release version is
// one edit to `tauri.conf.json` plus the renames the failure message names.
//
// # Compared BOTH ways
//
// A missing changelog and an orphaned one are different bugs (one loses the tab,
// the other is a lie about a version that no longer exists) and both fail, the
// shape `check-twin-inventory.mjs` and `check-manual-test-roster.mjs` use.
//
// # What this does NOT check, and why each is somebody else's
//
//  - **That the eight release version fields agree.** That roster lives in
//    `operations/runbooks/release-checklist.md` and spans the desktop, web and
//    mobile clients; this guard reads the one file the Android build consumes.
//    A mismatch with `mobile/package.json` is reported as a WARNING for that
//    reason, not as a failure.
//  - **That the recipe builds.** Only a real `fdroid build` answers that. The
//    procedure, and the list of what the first dry run owes, is
//    `mobile/fdroid/README.md`.
//  - **That the recipe's `Repo` is reachable.** F-Droid clones it itself; the
//    source has to be readable, which no offline guard can tell you.
//  - **The placeholder `commit:`.** Failing on it would make this repo
//    permanently red until submission, which is the "permanently-red gate
//    teaches people to ignore red" failure. It is a warning.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** F-Droid's own limits, from `All_About_Descriptions_Graphics_and_Screenshots`. */
export const LIMITS = {
  title: 50,
  shortDescription: 80,
  fullDescription: 4000,
  changelog: 500,
};

/**
 * The ABI digit, and the two strings that have to move with it. F-Droid installs
 * the highest versionCode a device can run, so the order is load-bearing:
 * armeabi-v7a below arm64-v8a, and the emulator ABIs above both.
 */
export const ABI_BY_DIGIT = {
  1: { cargoTarget: "armv7", outDir: "arm" },
  2: { cargoTarget: "aarch64", outDir: "arm64" },
  3: { cargoTarget: "i686", outDir: "x86" },
  4: { cargoTarget: "x86_64", outDir: "x86_64" },
};

/** Tauri's own Android default, and the Google Play ceiling it cites. */
export const VERSION_CODE_CEILING = 2100000000;

/**
 * `0.10.0` -> `{ base: 10000, codes: [100001, 100002, 100003, 100004] }`.
 *
 * The base is Tauri's formula (`major * 1000000 + minor * 1000 + patch`, the
 * documented default when `bundle.android.versionCode` is unset, which it is);
 * the per-ABI codes are the recipe's `prebuild` multiplier applied to it.
 */
export function deriveVersionCodes(version) {
  if (typeof version !== "string") return { error: `version is not a string: ${version}` };
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return { error: `version is not bare major.minor.patch: "${version}"` };
  const [major, minor, patch] = m.slice(1).map(Number);
  const base = major * 1000000 + minor * 1000 + patch;
  const codes = Object.keys(ABI_BY_DIGIT).map((d) => base * 10 + Number(d));
  const over = codes.filter((c) => c > VERSION_CODE_CEILING);
  if (over.length > 0) {
    return {
      error:
        `version ${version} derives versionCode ${over[0]}, above the ` +
        `${VERSION_CODE_CEILING} ceiling Tauri and Google Play enforce`,
    };
  }
  return { base, codes };
}

/**
 * One recipe build block, as far as this guard cares about it. Every field is
 * read from the shape the file actually has; a field that cannot be found comes
 * back `null` so the caller can name the block rather than crash on it.
 */
export function parseRecipeBlocks(text) {
  const lines = String(text).split("\n");
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^  - versionName: /.test(line)) {
      if (current) blocks.push(current);
      current = {
        versionName: line.replace(/^  - versionName: /, "").trim(),
        versionCode: null,
        digit: null,
        cargoTarget: null,
        output: null,
      };
      continue;
    }
    if (!current) continue;
    const code = /^    versionCode: (\d+)$/.exec(line);
    if (code) current.versionCode = Number(code[1]);
    const digit = /\.toInt\(\) \* 10 \+ (\d+)\|/.exec(line);
    if (digit) current.digit = Number(digit[1]);
    const target = /--target (\S+)$/.exec(line);
    if (target) current.cargoTarget = target[1];
    const output = /^    output: (\S+)$/.exec(line);
    if (output) current.output = output[1];
  }
  if (current) blocks.push(current);
  return blocks;
}

/** The `commit:` value of the first build block, for the placeholder warning. */
export function recipeCommit(text) {
  const m = /^    commit: (\S+)$/m.exec(String(text));
  return m ? m[1] : null;
}

/** PNG dimensions, without a dependency: the IHDR is at a fixed offset. */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const PLACEHOLDER_COMMIT = /^(REPLACE_|TODO|<)/;

/**
 * Every rule, over an injected scan. Pure: no filesystem, no process.
 *
 * @param {object} scan
 * @param {string} scan.version            `mobile/src-tauri/tauri.conf.json`'s version
 * @param {string|null} scan.packageVersion `mobile/package.json`'s version
 * @param {string} scan.recipe             the recipe YAML, as text
 * @param {string[]} scan.changelogs       changelog basenames, `.txt` included
 * @param {Record<string,string>} scan.texts  title/shortDescription/fullDescription bodies
 * @param {Buffer|null} scan.icon          `images/icon.png` bytes
 * @param {number} scan.phoneScreenshots   how many files `images/phoneScreenshots/` holds
 * @param {string[]} [scan.imageEntries]   the children of `images/`, for the ignored-name warning
 */
export function checkMetadata(scan) {
  const errors = [];
  const warnings = [];

  const derived = deriveVersionCodes(scan.version);
  if (derived.error) {
    errors.push(derived.error);
    return { errors, warnings, derived: null };
  }
  const expected = derived.codes;

  // 1. The recipe: four blocks, agreeing with the version and with each other.
  const blocks = parseRecipeBlocks(scan.recipe);
  if (blocks.length === 0) {
    errors.push(
      "the recipe parsed to zero build blocks — either the file is gone or its " +
        "shape moved, and this guard will not report ok over an input it could not read",
    );
  } else if (blocks.length !== 4) {
    errors.push(`the recipe has ${blocks.length} build blocks, expected 4 (one per ABI)`);
  }
  for (const [i, b] of blocks.entries()) {
    const at = `recipe block ${i + 1} (${b.versionName})`;
    if (b.versionName !== scan.version) {
      errors.push(`${at}: versionName is "${b.versionName}", tauri.conf.json says "${scan.version}"`);
    }
    if (b.versionCode === null) errors.push(`${at}: no versionCode`);
    if (b.digit === null) errors.push(`${at}: no "* 10 + <digit>" in its prebuild sed`);
    const abi = ABI_BY_DIGIT[b.digit];
    if (b.digit !== null && !abi) errors.push(`${at}: digit ${b.digit} is not an ABI index (1..4)`);
    if (abi) {
      if (b.cargoTarget !== abi.cargoTarget) {
        errors.push(`${at}: builds --target ${b.cargoTarget}, digit ${b.digit} means ${abi.cargoTarget}`);
      }
      if (b.output && !b.output.includes(`/apk/${abi.outDir}/release/`)) {
        errors.push(`${at}: output path is not under apk/${abi.outDir}/release/`);
      }
      const want = derived.base * 10 + b.digit;
      if (b.versionCode !== null && b.versionCode !== want) {
        errors.push(`${at}: versionCode ${b.versionCode}, digit ${b.digit} over base ${derived.base} gives ${want}`);
      }
    }
  }
  const recipeCodes = blocks.map((b) => b.versionCode).filter((c) => c !== null);
  for (const code of expected) {
    if (!recipeCodes.includes(code)) errors.push(`the recipe has no build block for versionCode ${code}`);
  }
  for (const code of recipeCodes) {
    if (!expected.includes(code)) {
      errors.push(`recipe versionCode ${code} is not one of ${expected.join(", ")} for ${scan.version}`);
    }
  }

  // 2. The changelogs, both ways.
  const names = scan.changelogs.filter((n) => /^\d+\.txt$/.test(n)).map((n) => Number(n.slice(0, -4)));
  for (const n of scan.changelogs) {
    if (!/^\d+\.txt$/.test(n)) {
      warnings.push(`changelogs/${n} is not <versionCode>.txt and F-Droid will not read it`);
    }
  }
  for (const code of expected) {
    if (!names.includes(code)) {
      errors.push(`fastlane/metadata/android/en-US/changelogs/${code}.txt is missing for ${scan.version}`);
    }
  }
  for (const code of names) {
    if (!expected.includes(code)) {
      errors.push(
        `changelogs/${code}.txt is orphaned: ${scan.version} derives ${expected.join(", ")}, ` +
          "so this file describes a version no build carries any more",
      );
    }
  }

  // 3. The listing's limits, which F-Droid enforces at the far end of a review.
  const title = scan.texts.title ?? "";
  const short = scan.texts.shortDescription ?? "";
  const full = scan.texts.fullDescription ?? "";
  if (title.length === 0) errors.push("title.txt is empty");
  if (short.length === 0) errors.push("short_description.txt is empty");
  if (full.length === 0) errors.push("full_description.txt is empty");
  if (title.length > LIMITS.title) {
    errors.push(`title.txt is ${title.length} chars, the limit is ${LIMITS.title}`);
  }
  if (short.length > LIMITS.shortDescription) {
    errors.push(`short_description.txt is ${short.length} chars, the limit is ${LIMITS.shortDescription}`);
  }
  if (/\.["']?\s*$/.test(short.trim())) {
    errors.push("short_description.txt ends with a full stop, which F-Droid rejects");
  }
  if (full.length > LIMITS.fullDescription) {
    errors.push(`full_description.txt is ${full.length} chars, the limit is ${LIMITS.fullDescription}`);
  }
  for (const n of scan.changelogs) {
    const body = scan.texts[`changelogs/${n}`];
    if (typeof body === "string" && body.length > LIMITS.changelog) {
      errors.push(`changelogs/${n} is ${body.length} chars, the limit is ${LIMITS.changelog}`);
    }
  }

  // 4. The graphics. A missing icon leaves the Latest tab with nothing to show.
  if (!scan.icon) {
    errors.push("images/icon.png is missing or not a PNG");
  } else {
    const size = pngSize(scan.icon);
    if (!size) {
      errors.push("images/icon.png is not a PNG (no IHDR magic)");
    } else if (size.width !== size.height) {
      warnings.push(`images/icon.png is ${size.width}x${size.height}, not square`);
    }
  }
  if (scan.phoneScreenshots < 1) {
    errors.push("images/phoneScreenshots/ holds no screenshots and the Latest tab wants at least one graphic");
  }
  // F-Droid reads a fixed set of names under `images/` and ignores the rest in
  // silence, so a typo (`phoneScreenshot/`) costs the graphics with nothing to
  // say so. Warn rather than fail: an unknown directory may also be something a
  // future F-Droid version reads.
  const KNOWN_IMAGE_ENTRIES = new Set([
    "icon.png",
    "featureGraphic.png",
    "tvBanner.png",
    "phoneScreenshots",
    "sevenInchScreenshots",
    "tenInchScreenshots",
    "tvScreenshots",
    "wearScreenshots",
  ]);
  for (const entry of scan.imageEntries ?? []) {
    if (!KNOWN_IMAGE_ENTRIES.has(entry)) {
      warnings.push(`images/${entry} is not a name F-Droid reads, so it will be ignored silently`);
    }
  }

  // 5. Warnings, not failures: both are true statements about work not yet done,
  //    and neither should keep an unrelated commit red.
  const commit = recipeCommit(scan.recipe);
  if (commit === null) {
    warnings.push("the recipe has no build commit line");
  } else if (PLACEHOLDER_COMMIT.test(commit)) {
    warnings.push(`the recipe's commit is the placeholder "${commit}"; fdroid lint will reject it`);
  }
  if (scan.packageVersion && scan.packageVersion !== scan.version) {
    warnings.push(
      `mobile/package.json says ${scan.packageVersion} while tauri.conf.json says ${scan.version}; ` +
        "the release checklist owns that roster, not this guard",
    );
  }

  return { errors, warnings, derived };
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Raised when an input the guard reads cannot be found. Never reported as ok. */
export class MissingInputError extends Error {}

/**
 * Read the real tree at `root` into the shape `checkMetadata` takes. Exported
 * with the root as a parameter so a test can drive the walk over a directory it
 * builds, rather than only injecting booleans past it.
 */
export function scanTreeAt(root) {
  const configPath = join(root, "mobile", "src-tauri", "tauri.conf.json");
  const recipePath = join(root, "mobile", "fdroid", "md.myne.mobile.yml");
  const packagePath = join(root, "mobile", "package.json");
  const meta = join(root, "fastlane", "metadata", "android", "en-US");

  const configText = readText(configPath);
  const recipeText = readText(recipePath);
  const packageText = readText(packagePath);

  const missing = [];
  if (configText === null) missing.push(configPath);
  if (recipeText === null) missing.push(recipePath);
  if (!existsSync(meta)) missing.push(meta);
  if (missing.length > 0) {
    throw new MissingInputError(
      `cannot read the F-Droid metadata's inputs:\n${missing.map((p) => `  ${p}`).join("\n")}`,
    );
  }

  const version = JSON.parse(configText).version;
  const packageVersion = packageText === null ? null : JSON.parse(packageText).version;

  const changelogDir = join(meta, "changelogs");
  const changelogs = existsSync(changelogDir)
    ? readdirSync(changelogDir).filter((n) => statSync(join(changelogDir, n)).isFile())
    : [];

  const texts = {
    title: readText(join(meta, "title.txt")) ?? "",
    shortDescription: readText(join(meta, "short_description.txt")) ?? "",
    fullDescription: readText(join(meta, "full_description.txt")) ?? "",
  };
  for (const n of changelogs) texts[`changelogs/${n}`] = readText(join(changelogDir, n)) ?? "";

  let icon = null;
  try {
    icon = readFileSync(join(meta, "images", "icon.png"));
  } catch {
    icon = null;
  }

  const shotDir = join(meta, "images", "phoneScreenshots");
  const phoneScreenshots = existsSync(shotDir) ? readdirSync(shotDir).length : 0;

  const imagesDir = join(meta, "images");
  const imageEntries = existsSync(imagesDir) ? readdirSync(imagesDir) : [];

  return {
    version,
    packageVersion,
    recipe: recipeText,
    changelogs,
    texts,
    icon,
    phoneScreenshots,
    imageEntries,
  };
}

function main() {
  let scan;
  try {
    scan = scanTreeAt(ROOT);
  } catch (e) {
    if (!(e instanceof MissingInputError)) throw e;
    console.error(`error: ${e.message}`);
    console.error("  A guard that reports ok over an input it could not find is not a guard.");
    process.exit(1);
  }
  const { errors, warnings, derived } = checkMetadata(scan);

  for (const w of warnings) console.log(`warn: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);

  if (errors.length > 0) {
    console.error(
      `\nfail: ${errors.length} problem(s) between ${scan.version} and the F-Droid store metadata.` +
        "\n      Renaming a release version means renaming the four changelog files and" +
        "\n      re-deriving the four versionCodes; see mobile/fdroid/README.md.",
    );
    process.exit(1);
  }

  console.log(
    `ok: mobile ${scan.version} -> versionCode ${derived.base} + ABI digit -> ` +
      `${derived.codes.join(", ")}; recipe and store listing agree` +
      (warnings.length > 0 ? ` (${warnings.length} warning(s))` : ""),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
