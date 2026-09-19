#!/usr/bin/env node
// The mobile plaintext-export directory stays out of the platform's automatic
// cloud backup, held together across files that no compiler compares
// (myne-md/myne#491, redesigned for the chokepoint in myne-md/myne#517).
//
// The failure this prevents: the mobile client writes plaintext into a
// device-visible directory in four places, the recovery phrase / account number
// (`secret-export.ts`), the whole-vault markdown tree (`export.ts`), a note's PDF
// (`EditorFlow.tsx`) and an exported attachment (`editor-host.ts`). Both mobile
// platforms back that directory up by default (iOS: `Documents/` in iCloud
// Backup; Android: `getExternalFilesDir(DIRECTORY_DOCUMENTS)` in Auto Backup), so
// a saved recovery phrase, which alone reconstructs the vault, was being copied
// to Apple and to Google. Nothing in the tree excluded it, and nothing said so:
// every build was green, every test passed, and the only way to see it was to
// restore a backup.
//
// The drift classes, numbered as the rules below are:
//
//   0. The seam reaches for a path accessor again, a SIBLING (`downloadDir()`)
//      that neither exclusion covers, or `documentDir()` itself, which is
//      excluded and still bypasses the sanitizer and the ordering.
//   2. The Android rules exclude under `<cloud-backup>` but not
//      `<device-transfer>` (a separate copy path that ignores it), or the
//      API<=30 file falls behind the API-31+ one (the only file every
//      pre-Android-12 device reads). Either half alone leaks.
//   3. The `android-widgets` manifest stops declaring the attributes or points
//      at a missing resource. Gradle resolves `@xml/...` at merge time, far from
//      anything a reviewer of this change would run.
//   4. `backup_exclude::init` is dropped from the setup hook, or the `ExportDir`
//      roster stops matching the directories the Android rules exclude. iOS then
//      excludes nothing, or the wrong directory, and reports success either way.
//   5. The chokepoint comes unwired: the seam stops calling it, the command
//      stops going through `backup_exclude::ensure_export_dir`, the capability
//      stops granting it, or the retired `core:path:` namespace comes back as
//      the route around it.
//
// The FIVE-SITE ACL lockstep found during this work is a sibling property and
// lives in `scripts/check-mobile-plugin-acl.mjs`, over all 27 mobile plugin
// permission directories rather than this one. Its header carries why that is a
// separate file.
//
// SCOPE, deliberately narrower than `scripts/lib/shared-roots.mjs`: mobile files
// alone, because the property is mobile-specific. Desktop and web pick a
// destination through an OS save dialog and have no platform-backup exposure of
// this kind. Stated because that library's header requires a narrower-scoped
// guard to say so rather than leave the omission reading as an oversight.
//
// WHAT THIS CANNOT SEE: it reads the COMMITTED files and proves they agree with
// each other. Whether iOS honours `NSURLIsExcludedFromBackupKey` and whether
// Android's backup service honours the merged rules are
// `mobile/docs/dev/device-matrix.md` §8 rows 8.9 and 8.10, both unrun. The macOS
// half of the iOS call is `backup_exclude::tests::macos`; the create-then-exclude
// ORDER is `backup_exclude::tests::the_exclusion_is_applied_before_the_caller_holds_a_path`.
// Those are the largest automatic claims available.
//
// NOT tracked, deliberately: `appDataDir()` / `appCacheDir()` /
// `appLocalDataDir()`. Those are app-private and hold the AEAD-encrypted vault,
// which is *meant* to be in a backup: a real safety net for a user who does not
// sync, disclosing nothing. This guard is about plaintext leaving the device by
// a route the user never chose.
//
// Zero dependencies, hand-runnable: node scripts/check-mobile-export-backup.mjs
// Testable: `analyse(io)` takes its whole world as an argument, so
// `tests/scripts/mobileExportBackup.test.ts` injects each defect above, and each
// defect in THIS FILE, and asserts the failure is named. A guard that has never
// failed is a guard nobody has tested (root `CLAUDE.md`).

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TS_FILES, walkFiles } from "./lib/surface-files.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Paths of the sides ─────────────────────────────────────────────────────
/**
 * The seam is a DIRECTORY and rule 0 reads every file in it, at every depth,
 * because `check-platform-seam.mjs` exempts it that way
 * (`rel === guard.seam || rel.startsWith(guard.seam + sep)`). Reading one FILE
 * was a hole, a sibling of `path.ts` re-exporting `downloadDir` compiles and
 * ships; reading one LEVEL was the same hole one directory down.
 */
export const SEAM_DIR = "mobile/src/platform";
/** The one seam member that must exist, because rule 5 reads it by name. */
export const PATH_SEAM = "mobile/src/platform/path.ts";
export const RUST_MODULE = "mobile/src-tauri/src/backup_exclude.rs";
export const RUST_SETUP = "mobile/src-tauri/src/lib.rs";
export const PLUGIN_MODULE = "mobile/src-tauri/src/plugins/export_dir/mod.rs";
export const BUILD_RS = "mobile/src-tauri/build.rs";
export const CAPABILITIES = "mobile/src-tauri/capabilities/default.json";
export const ANDROID_MANIFEST = "mobile/android-widgets/src/main/AndroidManifest.xml";
export const ANDROID_RULES_MODERN =
  "mobile/android-widgets/src/main/res/xml/myne_backup_rules.xml";
export const ANDROID_RULES_LEGACY =
  "mobile/android-widgets/src/main/res/xml/myne_backup_rules_legacy.xml";
/**
 * Where Gradle writes the manifest that actually ships. Git-ignored and absent
 * until somebody runs an Android build, so it is checked opportunistically: the
 * committed library manifest is the input, and this is the only place the
 * manifest-merger's PRECEDENCE can be observed. The merger takes the two
 * `<application>` attributes because the generated app manifest declares
 * neither; if a future Tauri template starts declaring one, the app's value wins
 * silently and every committed file still agrees with every other.
 */
export const ANDROID_MERGED_GLOB_ROOT =
  "mobile/src-tauri/gen/android/app/build/intermediates/merged_manifests";

/** The plugin the chokepoint lives in, and its one command. */
export const PLUGIN_NAME = "export-dir";
export const COMMAND = "export_path";
/**
 * The grant myne#517 dropped, matched as a NAMESPACE PREFIX. The literal
 * `"core:path:default"` alone let `allow-join` plus `allow-resolve-directory`
 * walk past, and those two reconstruct the route the wide grant gave while
 * looking like the careful version.
 */
export const RETIRED_GRANT_PREFIX = "core:path:";

/**
 * Why a given `@tauri-apps/api/path` name is refused, as a hint for the failure
 * message. Rule 0 refuses EVERY name, so nothing here decides the verdict; it
 * decides the wording, and a reviewer reading the failure should see which
 * argument is being made against the line they just wrote.
 *
 * Unlisted names get the general form, which is also the right answer for an
 * accessor nobody has classified.
 */
export const ACCESSOR_HINT = {
  documentDir: "that directory IS excluded, and that is not the same as safe",
  downloadDir: "nothing excludes that directory on EITHER platform",
  pictureDir: "nothing excludes that directory on EITHER platform",
  publicDir: "nothing excludes that directory on EITHER platform",
  audioDir: "nothing excludes that directory on EITHER platform",
  videoDir: "nothing excludes that directory on EITHER platform",
  homeDir: "nothing excludes that directory on EITHER platform",
  desktopDir: "nothing excludes that directory on EITHER platform",
  join: "it is path arithmetic, which is what turned a base directory and an untrusted name into a destination at four call sites",
  basename: "it is path arithmetic rather than a destination",
  dirname: "it is path arithmetic rather than a destination",
  extname: "it is path arithmetic rather than a destination",
  sep: "it is path arithmetic rather than a destination",
};

/**
 * Drop comments before any structural match.
 *
 * Load-bearing on BOTH sides, and the XML half was found by break-testing: the
 * rules files DOCUMENT the elements they contain, so `<device-transfer>` appears
 * in a comment above the real one. Without this, `blockBody()` anchored on the
 * comment's mention, ran its lazy body to the real closing tag, and swallowed the
 * `<cloud-backup>` block whole, so a `<device-transfer>` emptied of its
 * `<exclude>` still "contained" one and the guard passed.
 */
export const stripXmlComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, "");

/**
 * Strip `//` and block comments from TS/TSX source.
 *
 * String and template literals are stepped over rather than parsed, so a `//`
 * inside a URL literal does not eat the rest of the line. Regex literals are NOT
 * handled: a `/.../ ` containing `//` or `/*` would confuse this, and none exists
 * in the tree. That is a stated limit rather than a hidden one, and the failure
 * mode is a false FAILURE, never a silent pass.
 *
 * myne#517 deleted the call-site scan this also served and kept this function,
 * deliberately. Rule 0 reads the seam, and the seam's comment is thirty lines
 * explaining why it no longer imports `@tauri-apps/api/path`, naming
 * `documentDir`, `downloadDir` and the module specifier itself. Without
 * stripping, the inverted rule 0 fails on its own explanation.
 */
export function stripTsComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Strip Rust comments, both the line kind and the block kind, stepping over
 * double-quoted string literals.
 *
 * Line-ANCHORED for one review round, which left a TRAILING comment intact:
 * `Downloads, // note` then failed the variant filter below, so the variant
 * vanished from `variants`, from `inAll` and from `requiredDirs` at once, which
 * hid a whole export directory from the entire guard on both platforms. New to
 * the enum: the `&[&str]` roster it replaced was read as a slice body, where a
 * trailing comment is harmless.
 *
 * Single-quoted literals are deliberately NOT handled, and the reason is
 * specific to Rust: an apostrophe opens a lifetime far more often than a `char`,
 * and this file is full of `&'static`, so treating it as a delimiter would
 * swallow from `'static [ExportDir]` to the next one and take `ALL` with it.
 * Stated cost: a char literal holding a double quote would open a string running
 * to the next one. None exists in the file this reads, and the failure mode is
 * over-stripping, which fails BY NAME rather than passing silently.
 */
export function stripRustComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** `<exclude domain="..." path="..."/>` entries inside one XML block. */
export function excludedPaths(xml) {
  const dirs = new Set();
  for (const match of xml.matchAll(/<exclude\b[^>]*\/?>/g)) {
    const domain = match[0].match(/domain\s*=\s*"([^"]*)"/);
    const path = match[0].match(/path\s*=\s*"([^"]*)"/);
    if (domain?.[1] === "external" && path) dirs.add(path[1].replace(/\/+$/, ""));
  }
  return dirs;
}

/** The text between `<name>` and `</name>`, or null. */
export function blockBody(xml, name) {
  const match = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return match ? match[1] : null;
}

/**
 * Every file under `<root>/<dir>` matching `pattern`, recursively, as keys
 * relative to `root` with forward slashes, or `[]` when the directory is absent.
 *
 * `walkFiles` rather than a walk of our own: that module's header states the
 * rule ("a guard that needs a directory's files imports this") and carries the
 * `withFileTypes` measurement and the symlink narrowing that come with it. Two
 * things are added here and both are load-bearing. The slash normalisation,
 * because rule 0 compares a walked path against `PATH_SEAM` by equality and a
 * Windows `\` would make that miss silently, taking rule 5's seam check with it.
 * And `[]` for an absent directory rather than `walkFiles`'s default throw,
 * because rule 0 turns an empty seam into a NAMED failure ("a rule 0 that reads
 * nothing is a rule 0 that passes everything") and rule 3b is opportunistic by
 * design, so absence there is the ordinary case.
 */
function walk(root, dir, pattern) {
  const found = walkFiles([join(root, dir)], {
    relativeTo: root,
    extensions: pattern,
    missingIsNull: true,
  });
  return (found ?? []).map((file) => file.replaceAll("\\", "/"));
}

/** The default world: the real repository on disk. */
export function diskIo(root = repoRoot) {
  return {
    exists: (rel) => existsSync(join(root, rel)),
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    /**
     * Every `.ts` / `.tsx` under the seam directory, RECURSIVELY: see `SEAM_DIR`
     * for why one level was not enough. Sorted, so a failure list is stable.
     */
    listSeam: () => walk(root, SEAM_DIR, TS_FILES).sort(),
    /** Merged manifests, if an Android build has produced any. */
    listMergedManifests: () => walk(root, ANDROID_MERGED_GLOB_ROOT, /^AndroidManifest\.xml$/),
  };
}

/**
 * Run every rule against `io` and return `{ failures, requiredDirs, ... }`.
 *
 * Takes its whole world as an argument so a spec can hand it synthetic files.
 * That is the only way the break tests this guard's header describes can live
 * anywhere but in a shell transcript.
 */
export function analyse(io) {
  const failures = [];
  const fail = (message) => failures.push(message);
  /** Read `rel`, or record why it is missing and return null. */
  const readOrFail = (rel, why) => {
    if (!io.exists(rel)) {
      fail(`${rel}: ${why}`);
      return null;
    }
    return io.read(rel);
  };

  // ── 0. The seam reaches no path accessor (the INVERTED rule) ───────────────
  // `check-platform-seam.mjs` makes `mobile/src/platform/` the only place under
  // `mobile/src` allowed to import `@tauri-apps/*`, and it PERMITS that
  // DIRECTORY to import `@tauri-apps/api/path`. So the directory, not one file
  // in it, decides whether the WebView can name a destination at all, and after
  // myne#517 the answer is no. Adding an accessor back fails HERE, at the file
  // the author edits, rather than at whichever consumer first calls it.
  const seamFiles = io.listSeam();
  if (seamFiles.length === 0) {
    fail(
      `${SEAM_DIR}: no .ts/.tsx files found, so rule 0 read nothing. This guard is looking at the ` +
        `wrong tree, and a rule 0 that reads nothing is a rule 0 that passes everything.`,
    );
  }
  if (!io.exists(PATH_SEAM)) {
    fail(`${PATH_SEAM}: the mobile path seam is missing, this guard is looking at the wrong tree`);
  }

  /** The stripped source of `path.ts`, which rule 5 reads again. */
  let pathSeamSource = null;
  for (const file of seamFiles) {
    const source = stripTsComments(io.read(file));
    if (file === PATH_SEAM) pathSeamSource = source;
    if (!source.includes("@tauri-apps/api/path")) continue;

    const named = source.match(
      /(?:import|export)\s*\{([^}]*)\}\s*from\s*["']@tauri-apps\/api\/path["']/,
    );
    if (!named) {
      fail(
        `${file}: reaches \`@tauri-apps/api/path\` in a shape this guard cannot read. ` +
          `Since myne#517 this seam calls \`plugin:${PLUGIN_NAME}|${COMMAND}\` and imports no ` +
          `path accessor at all; if that has genuinely changed, teach the guard the new shape ` +
          `rather than removing it. Silence here is a guard that has stopped checking.`,
      );
      continue;
    }
    for (const raw of named[1].split(",")) {
      // `documentDir as docDir` binds under a new name; the local name is
      // what a consumer calls, and it is what a reader of this file sees.
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (!name) continue;
      const hint = ACCESSOR_HINT[name] ?? "it is an accessor this guard has never classified";
      fail(
        `${file}: re-exports \`${name}\`, and ${hint}. The seam has no reason to reach ` +
          `\`@tauri-apps/api/path\` at all since myne#517: the host answers "where does an ` +
          `export go", in the same call that creates the directory, applies the platform backup ` +
          `exclusion and sanitizes the filename. A path the WebView composes for itself has had ` +
          `none of those three applied to it, and anything plaintext written to a directory ` +
          `nothing excludes is carried to iCloud / Google Drive.`,
      );
    }
  }

  // ── 4. The iOS roster: a type, and the directories it names ────────────────
  // Moved ahead of the Android rules because it is now the SOURCE of the
  // directory names those rules are compared against. Before myne#517 that
  // roster was a hand-kept list in this file, cross-checked against the TS call
  // sites; the call sites are gone, so the enum in the Rust module is the one
  // place a directory is named and everything else is compared to it.
  const requiredDirs = new Set();
  const rust = readOrFail(RUST_MODULE, "missing, iOS excludes nothing");
  if (rust !== null) {
    const source = stripRustComments(rust);
    const enumBlock = source.match(/pub enum ExportDir\s*\{([\s\S]*?)\n\}/);
    const allDecl = source.match(/ALL:\s*&'static\s*\[ExportDir\]\s*=\s*&\[([^\]]*)\]/);
    const nameFn = source.match(
      /fn name\(self\)\s*->\s*&'static str\s*\{([\s\S]*?)\n {4}\}/,
    );

    if (!enumBlock) {
      fail(
        `${RUST_MODULE}: could not find \`pub enum ExportDir { … }\`, did it get renamed? ` +
          `This guard reads the variant list to know which directories the iOS side excludes; ` +
          `reporting ok on an input it could not read is the one answer that is never right.`,
      );
    }
    if (!allDecl) {
      fail(`${RUST_MODULE}: could not find \`ALL: &'static [ExportDir] = &[…]\`, did it get renamed?`);
    }
    if (!nameFn) {
      fail(`${RUST_MODULE}: could not find \`fn name(self) -> &'static str\`, did it get renamed?`);
    }

    if (enumBlock && allDecl && nameFn) {
      // A line this filter does not recognise FAILS rather than being dropped.
      // The trailing-comment bypass was a dropped line, and a filter that
      // silently discards what it cannot parse will lose the next shape too
      // (`Downloads = 1,`, a `cfg` attribute on a variant, a tuple variant).
      // Blank lines and attributes are the only legitimate non-variants.
      const variants = new Set();
      for (const raw of enumBlock[1].split("\n")) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#[")) continue;
        if (!/^[A-Z][A-Za-z0-9]*,?$/.test(line)) {
          fail(
            `${RUST_MODULE}: \`enum ExportDir\` holds a line this guard cannot parse as a ` +
              `variant: ${JSON.stringify(line)}. It would be DROPPED, and a dropped variant is ` +
              `absent from the roster, from \`ALL\` and from the directory names rules 2 and 3 ` +
              `hold the Android XML to, all at once. Teach the guard the shape rather than ` +
              `leaving it to be discarded.`,
          );
          continue;
        }
        variants.add(line.replace(/,$/, ""));
      }
      const inAll = new Set([...allDecl[1].matchAll(/ExportDir::([A-Za-z0-9]+)/g)].map((m) => m[1]));
      const named = new Map(
        [...nameFn[1].matchAll(/ExportDir::([A-Za-z0-9]+)\s*=>\s*"([^"]*)"/g)].map((m) => [
          m[1],
          m[2],
        ]),
      );

      // 4a. The one hole the enum opens that the old `&[&str]` did not have.
      // `resolve()` and `name()` are exhaustive matches, so a variant cannot
      // exist without a resolver or a name and the compiler says so. `ALL` is a
      // hand-written slice, so a variant can be fully wired and still never be
      // walked by `init`.
      for (const variant of variants) {
        if (!inAll.has(variant)) {
          fail(
            `${RUST_MODULE}: \`ExportDir::${variant}\` is declared and is absent from ` +
              `\`ExportDir::ALL\`, so \`backup_exclude::init\` never excludes it at startup. ` +
              `Every match on it is exhaustive and the compiler is satisfied; this is the one ` +
              `part of the roster a type cannot hold.`,
          );
        }
      }
      // 4b. The directory NAMES, which are what the Android XML and rule 2 below
      // address. A variant with no `name()` arm at all is E0004, so that case
      // cannot reach this guard; what this guard reads is a `_ =>` catch-all,
      // which compiles and answers for every future variant at once.
      if (/_\s*=>/.test(nameFn[1])) {
        fail(
          `${RUST_MODULE}: \`name()\` has a \`_ =>\` catch-all, so a new variant silently ` +
            `inherits some other directory's name instead of failing to compile.`,
        );
      }

      // 4b-i. The directory names, read from TWO rosters that must agree.
      //
      // `named` is the one the COMPILER guarantees: `name()` is an exhaustive
      // `match self`, so every variant has an arm or the crate does not build,
      // and the one way to satisfy that without naming each variant is the
      // `_ =>` catch-all the check directly above refuses. The enum body is a
      // regex over source lines, which is a weaker claim about the same set.
      //
      // What this replaces is `if (dir && inAll.has(variant))`, where `dir` was
      // `named.get(variant)` and the `&&` was doing two silent drops. An arm
      // this guard cannot READ leaves the variant out of `named`: a block body
      // `ExportDir::X => { "X" }`, a named constant instead of a string literal,
      // an `A | B => "x"` alternation. The empty name leaves it falsy. Either
      // way the directory left `requiredDirs`, which is the set rules 2 and 3
      // hold the Android XML to, so the XML stopped having to exclude it, on a
      // green run, with nothing naming it. That is the defect the enum-body
      // parser eleven lines up refuses to permit on its own side, left open on
      // this one, and closing one arm of the `&&` while leaving the other is how
      // a blind spot moves one token over rather than going away.
      //
      // So both drops FAIL by name, and the roster stays the INTERSECTION rather
      // than becoming `named` outright. That last part is not a detail and the
      // spec is what said so: driving the set off `named` alone made an EMPTY
      // enum body still produce a roster, which walked straight past the vacuity
      // floor below, the one check that exists for "rules 2 and 3 compared
      // nothing". An intersection can only ever shrink toward that floor, never
      // fabricate a roster, so the two hold each other rather than trading
      // places.
      for (const variant of named.keys()) {
        if (!variants.has(variant)) {
          fail(
            `${RUST_MODULE}: \`name()\` has an arm for \`ExportDir::${variant}\`, which the ` +
              `enum-body parse did not see as a variant. The two readings of the roster ` +
              `disagree, and rules 2 and 3 compare the Android XML against what they share.`,
          );
        }
      }
      for (const variant of variants) {
        const dir = named.get(variant);
        if (dir === undefined) {
          fail(
            `${RUST_MODULE}: \`ExportDir::${variant}\` is declared and this guard could not ` +
              `read its \`name()\` arm. \`name()\` is exhaustive, so the arm exists and is ` +
              `written in a shape this guard does not match (a block body \`=> { "…" }\`, a ` +
              `named constant instead of a literal, or an \`A | B => "…"\` alternation). The ` +
              `directory would be absent from the set rules 2 and 3 hold the Android XML to, ` +
              `so nothing would require the XML to exclude it. Teach the guard the shape ` +
              `rather than leaving the name to be dropped.`,
          );
          continue;
        }
        if (dir === "") {
          fail(
            `${RUST_MODULE}: \`ExportDir::${variant}\`'s \`name()\` arm is the empty string, ` +
              `so it names no directory for rules 2 and 3 to require of the Android XML.`,
          );
          continue;
        }
        if (inAll.has(variant)) requiredDirs.add(dir);
      }

      // 4c. The command's destination is one of the directories startup
      // excludes. The command applies the exclusion itself, so this is not what
      // keeps the export safe on iOS, it is what keeps the ANDROID rules,
      // which are declarative and keyed on these names, pointed at the
      // directory the exports actually land in.
      const destination = source.match(
        /const EXPORT_DESTINATION:\s*ExportDir\s*=\s*ExportDir::([A-Za-z0-9]+)/,
      );
      // Two checks, not one: the const says WHICH directory, and this says the
      // resolver actually uses it. Reading only the const would pass a tree
      // where `ensure_export_dir` had gone back to naming a variant inline,
      // which is the state that let the command's `path` and its `dir` label
      // come from two independent mentions.
      // Latently loose and tight on today's tree, said out loud rather than
      // left to be discovered: neither end is anchored, so `fn
      // ensure_export_dir_v2` satisfies the left and a longer const name would
      // satisfy the right. Nothing in the file defines either today, and the
      // lazy span between them cannot cross the function because no other
      // `ensure(app, EXPORT_DESTINATION)` exists. Anchor both if a second
      // resolver or a second const ever lands.
      if (!/fn ensure_export_dir[\s\S]*?ensure\(app,\s*EXPORT_DESTINATION\)/.test(source)) {
        fail(
          `${RUST_MODULE}: \`ensure_export_dir\` does not resolve \`EXPORT_DESTINATION\`. That ` +
            `const is the ONE place the export directory is chosen, and the plugin's \`dir\` label ` +
            `reads it too; a variant named inline here means the path and the label can disagree.`,
        );
      }
      if (!destination) {
        fail(
          `${RUST_MODULE}: could not find \`const EXPORT_DESTINATION: ExportDir = ExportDir::…\`, ` +
            `so the guard cannot say which directory the exports land in. That const is what ` +
            `\`plugin:${PLUGIN_NAME}|${COMMAND}\` resolves.`,
        );
      }
      // Deliberately NOT also checking that `EXPORT_DESTINATION` is in `ALL`:
      // 4a already fails on any declared variant absent from `ALL`, so that arm
      // produced two messages for one defect and there is no reachable input
      // where it fires alone.
    }
  }

  // The vacuity floor, and it is inside the guard rather than only in its spec:
  // rules 2 and 3 iterate `requiredDirs`, so an empty set makes both of them
  // pass over any Android file at all, including an empty one.
  if (requiredDirs.size === 0) {
    fail(
      `${RUST_MODULE}: the directory roster came back EMPTY, so the Android rules and the ` +
        `manifest were compared against nothing and rules 2 and 3 below checked no directory. ` +
        `A guard that passes because it read nothing is the failure this whole file exists to ` +
        `prevent, one file over.`,
    );
  }

  // ── 2. The Android rules exclude every required dir, in every block ─────────
  // Table-driven so the "both files must exclude the same paths" invariant the
  // XML headers promise is visible in the code rather than implied by two copies.
  const RULE_FILES = [
    {
      file: ANDROID_RULES_MODERN,
      // BOTH blocks, not one: device transfer is a separate copy path that
      // ignores the cloud-backup block entirely.
      blocks: ["cloud-backup", "device-transfer"],
      missing: "missing, Android 12+ has no backup exclusion",
      why: "Plaintext exports leave the device by that path.",
    },
    {
      file: ANDROID_RULES_LEGACY,
      blocks: ["full-backup-content"],
      missing: "missing, every Android <= 11 device backs the exports up",
      why:
        "android:dataExtractionRules is ignored below API 31, so this file is the only " +
        "exclusion pre-Android-12 devices read.",
    },
  ];

  for (const { file, blocks, missing, why } of RULE_FILES) {
    const raw = readOrFail(file, missing);
    if (raw === null) continue;
    const xml = stripXmlComments(raw);
    for (const name of blocks) {
      const body = blockBody(xml, name);
      if (body === null) {
        fail(`${file}: no <${name}> block, that copy path is unguarded`);
        continue;
      }
      const excluded = excludedPaths(body);
      for (const dir of requiredDirs) {
        if (!excluded.has(dir)) {
          fail(
            `${file}: <${name}> does not exclude domain="external" path="${dir}". ${why}`,
          );
        }
      }
    }
  }

  // ── 3. The library manifest declares both attributes, at real resources ─────
  const ATTRS = [
    ["android:dataExtractionRules", "myne_backup_rules", ANDROID_RULES_MODERN, "API 31+"],
    ["android:fullBackupContent", "myne_backup_rules_legacy", ANDROID_RULES_LEGACY, "API <= 30"],
  ];
  const manifestRaw = readOrFail(
    ANDROID_MANIFEST,
    "missing, nothing points Android at the backup rules",
  );
  if (manifestRaw !== null) {
    const manifest = stripXmlComments(manifestRaw);
    for (const [attr, resource, file, api] of ATTRS) {
      const match = manifest.match(new RegExp(`${attr}\\s*=\\s*"@xml/([A-Za-z0-9_]+)"`));
      if (!match) {
        fail(
          `${ANDROID_MANIFEST}: no \`${attr}\` on <application>, ${api} devices fall back ` +
            `to backing everything up, including the plaintext export directory.`,
        );
        continue;
      }
      if (match[1] !== resource) {
        fail(
          `${ANDROID_MANIFEST}: \`${attr}\` points at "@xml/${match[1]}", expected ` +
            `"@xml/${resource}" (${file}).`,
        );
        continue;
      }
      if (!io.exists(file)) {
        fail(`${ANDROID_MANIFEST}: \`${attr}\` points at "@xml/${resource}", which does not exist.`);
      }
    }
  }

  // ── 3b. The MERGED manifest, when a build has produced one ─────────────────
  // Opportunistic: `gen/android` is git-ignored, so this is silent in a fresh
  // clone and in CI. It is the only place merger PRECEDENCE can be observed, and
  // precedence is the one link the committed files cannot speak for.
  const merged = io.listMergedManifests();
  for (const file of merged) {
    const xml = stripXmlComments(io.read(file));
    for (const [attr, resource, , api] of ATTRS) {
      const match = xml.match(new RegExp(`${attr}\\s*=\\s*"@xml/([A-Za-z0-9_]+)"`));
      if (!match) {
        fail(
          `${file}: the MERGED manifest carries no \`${attr}\`, so the committed library value ` +
            `did not survive the manifest merger and ${api} devices back the export directory up. ` +
            `Check whether the generated app manifest now declares it (the app's value wins).`,
        );
      } else if (match[1] !== resource) {
        fail(
          `${file}: the MERGED manifest's \`${attr}\` is "@xml/${match[1]}", not ` +
            `"@xml/${resource}", something outranked the library value.`,
        );
      }
    }
  }

  // ── 4d. The startup entry point is still wired ─────────────────────────────
  // Kept even though the command now applies the exclusion on every export.
  // `init` carries the startup REPAIR of a container restored from an older
  // backup, which no export-time call can do, and it is what makes
  // `device-matrix.md` row 8.9 runnable as written.
  const setup = readOrFail(RUST_SETUP, "missing");
  if (setup !== null) {
    if (!/\bbackup_exclude::init\s*\(/.test(setup)) {
      fail(
        `${RUST_SETUP}: no \`backup_exclude::init(...)\` call. The module compiles, the guard's ` +
          `other checks pass, and the startup repair of a restored container silently stops ` +
          `happening, the shipped-inert shape.`,
      );
    }
    if (!/^\s*mod backup_exclude;/m.test(setup)) {
      fail(`${RUST_SETUP}: \`mod backup_exclude;\` is not declared.`);
    }
  }

  // ── 5. The chokepoint is wired, and the route around it stays shut ────────
  // Narrowed deliberately. The five-site ACL lockstep this rule used to carry
  // moved to `scripts/check-mobile-plugin-acl.mjs`, where it covers all 27
  // mobile plugin permission directories instead of this one. What stays here
  // is the part about the export path.
  const invokeLiteral = `plugin:${PLUGIN_NAME}|${COMMAND}`;
  // Bounded, not `includes`. A substring match accepts
  // `plugin:export-dir|export_pathh`, which is a command that does not exist and
  // an export flow that fails at runtime, and the guard said ok.
  const invokeRe = new RegExp(`plugin:${PLUGIN_NAME}\\|${COMMAND}(?![A-Za-z0-9_])`);
  if (pathSeamSource !== null && !invokeRe.test(pathSeamSource)) {
    fail(
      `${PATH_SEAM}: does not invoke \`${invokeLiteral}\`. The seam is the only route from an ` +
        `export flow to a destination; if it stopped calling the chokepoint, it is composing one ` +
        `some other way.`,
    );
  }

  const plugin = readOrFail(
    PLUGIN_MODULE,
    `missing, the ${PLUGIN_NAME} chokepoint has no implementation`,
  );
  if (plugin !== null) {
    const source = stripRustComments(plugin);
    // Bounded, for the same reason the invoke literal above is: an unanchored
    // `includes` is satisfied by any name this one PREFIXES, so renaming the
    // call to `ensure_export_dir_unchecked` left the guard printing ok on a
    // tree where the function it names is not called. Deleting the call outright
    // is the injection that does NOT find this; renaming it is the one that does.
    if (!/backup_exclude::ensure_export_dir(?![A-Za-z0-9_])/.test(source)) {
      fail(
        `${PLUGIN_MODULE}: does not call \`backup_exclude::ensure_export_dir\`. That function IS ` +
          `the resolve + create + exclude body; a command that resolves the directory some other ` +
          `way returns a path nothing excluded.`,
      );
    }
    if (!new RegExp(`fn ${COMMAND}\\b`).test(source)) {
      fail(`${PLUGIN_MODULE}: no \`fn ${COMMAND}\`, the command this whole namespace exists for.`);
    }
    // These two did NOT travel to `check-mobile-plugin-acl.mjs` and belong here:
    // that guard reads the ACL files, and these are the Rust half of the same
    // command being reachable at all.
    if (!new RegExp(`generate_handler!\\[[^\\]]*\\b${COMMAND}\\b`).test(source)) {
      fail(
        `${PLUGIN_MODULE}: \`${COMMAND}\` is not in \`generate_handler!\`, so it is not ` +
          `registered and every invoke is refused at runtime however the ACL reads.`,
      );
    }
    if (!new RegExp(`Builder::<R>::new\\("${PLUGIN_NAME}"\\)`).test(source)) {
      fail(
        `${PLUGIN_MODULE}: the plugin is not built as \`"${PLUGIN_NAME}"\`, so its commands do ` +
          `not answer to the \`${invokeLiteral}\` form the ACL authorizes.`,
      );
    }
  }

  // C11: `build.rs` must declare the plugin AND list the command. The ACL guard
  // requires every DECLARED command to be allowed; it cannot require a command
  // to be declared, because naming one there is optional in general. For this
  // chokepoint it is not optional, and this is where that is said.
  const buildRs = readOrFail(BUILD_RS, "missing");
  if (buildRs !== null) {
    const declaredHere = buildRs.match(
      new RegExp(`"${PLUGIN_NAME}",\\s*tauri_build::InlinedPlugin::new\\(\\)[\\s\\S]*?\\)`),
    );
    if (!declaredHere) {
      fail(
        `${BUILD_RS}: no \`InlinedPlugin\` declared for "${PLUGIN_NAME}". Without it the ` +
          `permissions under \`permissions/${PLUGIN_NAME}/\` flatten into \`__app-acl__\` and ` +
          `never match the \`${invokeLiteral}\` authorize form.`,
      );
    } else if (!new RegExp(`"${COMMAND}"`).test(declaredHere[0])) {
      fail(`${BUILD_RS}: the "${PLUGIN_NAME}" InlinedPlugin does not list \`${COMMAND}\`.`);
    }
  }

  const capabilities = readOrFail(CAPABILITIES, "missing");
  if (capabilities !== null) {
    if (!new RegExp(`"${PLUGIN_NAME}:default"`).test(capabilities)) {
      fail(
        `${CAPABILITIES}: does not grant \`"${PLUGIN_NAME}:default"\`, so the main window cannot ` +
          `call the chokepoint. Whether that grant RESOLVES to a real permission set is ` +
          `\`scripts/check-mobile-plugin-acl.mjs\`.`,
      );
    }
    // The other direction of the narrowing myne#517 bought, and it is a ratchet.
    for (const match of capabilities.matchAll(
      new RegExp(`"(${RETIRED_GRANT_PREFIX}[^"]*)"`, "g"),
    )) {
      fail(
        `${CAPABILITIES}: grants \`"${match[1]}"\` again. myne#517 dropped the whole ` +
          `\`${RETIRED_GRANT_PREFIX}\` namespace: nothing under \`mobile/src\` and no ` +
          `\`@tauri-apps/*\` package it imports calls \`plugin:path|*\`. If a consumer genuinely ` +
          `needs it, name the consumer in review rather than re-adding the grant, because it is ` +
          `also the route around \`${invokeLiteral}\`.`,
      );
    }
  }

  if (setup !== null && !/\bplugins::export_dir::init\s*\(/.test(setup)) {
    fail(
      `${RUST_SETUP}: no \`plugins::export_dir::init()\` registration. The plugin compiles, the ` +
        `ACL grants it, and the command answers to nothing.`,
    );
  }

  return {
    failures,
    requiredDirs,
    mergedManifests: merged.length,
  };
}

// ── Report ─────────────────────────────────────────────────────────────────
// Only when run directly, so importing this module for a spec has no side effect.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { failures, requiredDirs, mergedManifests } = analyse(diskIo());
  if (failures.length > 0) {
    console.error("mobile export-backup exclusion: FAILED");
    for (const message of failures) console.error(`  - ${message}`);
    console.error(
      "\n  Why this is a gate: a saved recovery phrase alone reconstructs the vault, so a copy\n" +
        "  of it in iCloud or Google Drive is a complete break of the zero-knowledge posture,\n" +
        "  reached without any adversary doing anything. See design-notes/security/0506-* and\n" +
        "  design-notes/security/0595-*.",
    );
    process.exit(1);
  }
  console.log(
    `mobile export-backup exclusion: ok (chokepoint plugin:${PLUGIN_NAME}|${COMMAND}, ` +
      `excluded dirs: ${[...requiredDirs].join(", ")}` +
      // Says when it compared NOTHING, not only when it compared something. Rule
      // 3b is opportunistic (`gen/android` is git-ignored, so it is absent in a
      // fresh clone and in CI), and printing the count only when non-zero made a
      // run that skipped merger precedence byte-identical to one that checked
      // it. A silent skip reads as a pass, which is the failure this repository
      // records by name elsewhere.
      (mergedManifests > 0
        ? `; ${mergedManifests} merged manifest(s) checked`
        : `; NO merged manifest present, so rule 3b compared nothing (run an Android build to ` +
          `check manifest-merger precedence)`) +
      `)`,
  );
}
