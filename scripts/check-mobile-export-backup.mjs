#!/usr/bin/env node
// The mobile plaintext-export directory stays out of the platform's automatic
// cloud backup — held together across FOUR files that no compiler compares
// (myne-md/myne#491).
//
// The failure this prevents: the mobile client writes plaintext into a
// device-visible directory in four places — the recovery phrase / account number
// (`secret-export.ts`), the whole-vault markdown tree (`export.ts`), a note's PDF
// (`EditorFlow.tsx`) and an exported attachment (`editor-host.ts`). Both mobile
// platforms back that directory up by default (iOS: `Documents/` in iCloud
// Backup; Android: `getExternalFilesDir(DIRECTORY_DOCUMENTS)` in Auto Backup), so
// a saved recovery phrase — which alone reconstructs the vault — was being copied
// to Apple and to Google. Nothing in the tree excluded it, and nothing said so:
// every build was green, every test passed, and the only way to see it was to
// restore a backup.
//
// The fix is a property of the DESTINATION, and it lives in two unrelated
// languages plus a manifest, so it drifts silently in four distinct ways:
//
//   1. A new export flow reaches for a SIBLING accessor — `downloadDir()`,
//      `pictureDir()` — that neither exclusion covers. Compiles, ships, backed up.
//   2. The Android rules exclude the path under `<cloud-backup>` but not
//      `<device-transfer>` (or the API<=30 file falls behind the API-31+ one).
//      Phone-to-phone transfer is a separate copy path that ignores the
//      cloud-backup block, and `fullBackupContent` is what every pre-Android-12
//      device reads. Either half alone leaves the phrase leaving the device.
//   3. The `android-widgets` library manifest stops declaring the attributes, or
//      points them at a resource that does not exist. Gradle resolves `@xml/...`
//      at merge time, far from anything a reviewer of this change would run.
//   4. `backup_exclude::init` is dropped from the mobile setup hook, or its
//      `EXCLUDED_DIRS` stops matching the directories the TS side actually writes
//      to. The iOS half then excludes nothing, or excludes the wrong directory,
//      and reports success either way.
//
// So this guard compares the four sides against ONE roster, in BOTH directions
// (a recorded site that vanished is a stale roster, which is how a roster stops
// describing anything).
//
// SCOPE, deliberately narrower than `scripts/lib/shared-roots.mjs`: this walks
// `mobile/src` alone and does NOT import the shared-roots roster, because the
// property is mobile-specific. Desktop and web choose an export destination
// through an OS save dialog and have no platform-backup exposure of this kind.
// Stated here because that library's header requires a guard that scopes narrower
// to say so, rather than leaving the omission to read as an oversight.
//
// WHAT THIS GUARD CANNOT SEE, so it is not mistaken for more than it is: it reads
// the four COMMITTED files and proves they agree with each other. Whether iOS
// honours `NSURLIsExcludedFromBackupKey` on a device, and whether Android's
// backup service honours the merged rules, are `mobile/docs/dev/device-matrix.md`
// §8 rows 8.9 and 8.10. The macOS half of the iOS call is covered by
// `backup_exclude::tests::macos`, which is the largest automatic claim available.
//
// NOT tracked, deliberately: `appDataDir()` / `appCacheDir()` /
// `appLocalDataDir()`. Those are app-private and hold the AEAD-encrypted vault,
// which is *meant* to be in a backup — that is a genuine safety net for a user
// who does not sync, and it discloses nothing. This guard is about plaintext
// leaving the device by a route the user never chose.
//
// Zero dependencies, hand-runnable: node scripts/check-mobile-export-backup.mjs
// Testable: `analyse(io)` takes its whole world as an argument, so
// `tests/scripts/mobileExportBackup.test.ts` can inject each defect above and
// assert the guard names it. A guard that has never failed is a guard nobody has
// tested (root `AGENTS.md`).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Paths of the four sides ────────────────────────────────────────────────
export const TS_ROOT = "mobile/src";
export const PATH_SEAM = "mobile/src/platform/path.ts";
export const RUST_MODULE = "mobile/src-tauri/src/backup_exclude.rs";
export const RUST_SETUP = "mobile/src-tauri/src/lib.rs";
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

/**
 * `@tauri-apps/api/path` accessors that resolve to a DEVICE-VISIBLE directory —
 * one the platform backs up and the user can plausibly reach — mapped to the
 * directory name the Android backup rules and the iOS roster use.
 *
 * `null` means "no exclusion is wired for this accessor at all": using it is an
 * egress channel that nothing closes, so the guard fails and the author has to
 * either wire it on both platforms or argue for it in review.
 *
 * This map is a DENYLIST and denylists are incomplete by construction — it names
 * eight of the API's accessors and Tauri has more. Rule 0 is what makes the
 * coverage complete anyway: `mobile/src/platform/path.ts` is the ONE file under
 * `mobile/src` allowed to import `@tauri-apps/api/path` (`check-platform-seam.mjs`
 * enforces that), so its re-export list is the entire set of accessors the tree
 * can reach, and rule 0 fails on any name in it this map has not classified.
 */
export const TRACKED_ACCESSORS = {
  documentDir: "Documents",
  downloadDir: null,
  pictureDir: null,
  publicDir: null,
  audioDir: null,
  videoDir: null,
  homeDir: null,
  desktopDir: null,
};

/** Accessors that are not directory destinations and so need no exclusion. */
export const NON_DESTINATION_EXPORTS = new Set(["join", "basename", "dirname", "extname", "sep"]);

/**
 * The recorded roster: every device-visible-directory call site in `mobile/src`,
 * with why it is legitimate. A site absent here fails; a recorded site that no
 * longer exists fails too (a roster nobody prunes stops being a roster).
 */
export const ROSTER = [
  {
    file: "mobile/src/lib/secret-export.ts",
    accessor: "documentDir",
    reason:
      "recovery phrase / account number .txt — the TB3 user-initiated plaintext egress the creation flow offers (myne#491 is about exactly this file)",
  },
  {
    file: "mobile/src/lib/export.ts",
    accessor: "documentDir",
    reason: "whole-vault plaintext markdown tree export destination",
  },
  {
    file: "mobile/src/app/flows/EditorFlow.tsx",
    accessor: "documentDir",
    reason: "note → PDF export destination (mobile has no save dialog)",
  },
  {
    file: "mobile/src/editor-host.ts",
    accessor: "documentDir",
    reason: "decrypted attachment export destination (mobile has no save dialog)",
  },
];

/**
 * Drop comments before any structural match.
 *
 * Load-bearing on BOTH sides, and the XML half was found by break-testing: the
 * rules files DOCUMENT the elements they contain, so `<device-transfer>` appears
 * in a comment above the real one. Without this, `blockBody()` anchored on the
 * comment's mention, ran its lazy body to the real closing tag, and swallowed the
 * `<cloud-backup>` block whole — so a `<device-transfer>` emptied of its
 * `<exclude>` still "contained" one and the guard passed.
 *
 * The TS half is the same hole one language over, and it cuts both ways: a
 * commented `downloadDir()` anywhere under `mobile/src` would fail the commit
 * against a call site that does not exist, and — worse — deleting the real
 * `documentDir()` call from a rostered file while a comment there still writes
 * `documentDir(` keeps the entry "found", so the stale-roster direction reports
 * nothing. This change adds multi-paragraph comments about exactly these
 * accessors to four rostered files, so the shape is live rather than theoretical.
 */
export const stripXmlComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, "");

/**
 * Strip `//` and block comments from TS/TSX source.
 *
 * String and template literals are stepped over rather than parsed, so a `//`
 * inside a URL literal does not eat the rest of the line. Regex literals are NOT
 * handled: a `/.../ ` containing `//` or `/*` would confuse this, and none exists
 * in the tree. That is a stated limit rather than a hidden one, and the failure
 * mode is a false FAILURE (over-stripping loses a call site, so the roster's
 * stale-entry direction fires and names the file), never a silent pass.
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

/** Every `.ts`/`.tsx` file under `dir`, as absolute paths. */
function walkTs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The default world: the real repository on disk. */
export function diskIo(root = repoRoot) {
  return {
    exists: (rel) => existsSync(join(root, rel)),
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    listTs: (rel) => {
      const abs = join(root, rel);
      if (!existsSync(abs)) return [];
      return walkTs(abs).map((file) => relative(root, file).replaceAll("\\", "/"));
    },
    /** Merged manifests, if an Android build has produced any. */
    listMergedManifests: () => {
      const abs = join(root, ANDROID_MERGED_GLOB_ROOT);
      if (!existsSync(abs)) return [];
      const found = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name === "AndroidManifest.xml")
            found.push(relative(root, full).replaceAll("\\", "/"));
        }
      };
      walk(abs);
      return found;
    },
  };
}

/**
 * Run every rule against `io` and return `{ failures, requiredDirs, callSites }`.
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

  // ── 0. The seam's export list is the complete set of reachable accessors ──
  // `check-platform-seam.mjs` makes `mobile/src/platform/` the only place under
  // `mobile/src` allowed to import `@tauri-apps/*`, so this one line decides
  // which path accessors the whole tree can call. Classifying it here is what
  // turns TRACKED_ACCESSORS from an incomplete denylist into complete coverage:
  // adding `downloadDir` to the seam fails HERE, at the file the author edits,
  // rather than at whichever consumer first calls it unaliased.
  const seam = readOrFail(PATH_SEAM, "the mobile path seam is missing — this guard is looking at the wrong tree");
  if (seam !== null) {
    const reexport = stripTsComments(seam).match(
      /export\s*\{([^}]*)\}\s*from\s*["']@tauri-apps\/api\/path["']/,
    );
    if (!reexport) {
      fail(
        `${PATH_SEAM}: no \`export { … } from "@tauri-apps/api/path"\` found. This guard reads ` +
          `that list to know which path accessors the mobile tree can reach at all; if the seam ` +
          `now re-exports some other way, teach the guard the new shape rather than removing it.`,
      );
    } else {
      for (const raw of reexport[1].split(",")) {
        // `documentDir as docDir` re-exports under a new name; the local name is
        // what a consumer calls, and it is what the scan below would look for.
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
        if (!name || NON_DESTINATION_EXPORTS.has(name)) continue;
        if (!(name in TRACKED_ACCESSORS)) {
          fail(
            `${PATH_SEAM}: re-exports \`${name}\`, which this guard has never classified. ` +
              `Every path accessor the mobile tree can reach must be a key of TRACKED_ACCESSORS ` +
              `(mapped to the directory its exclusion covers, or null if none is wired) or listed ` +
              `in NON_DESTINATION_EXPORTS. An unclassified accessor is a destination nothing ` +
              `excludes from platform backup.`,
          );
          continue;
        }
        if (TRACKED_ACCESSORS[name] === null) {
          fail(
            `${PATH_SEAM}: re-exports \`${name}\`, and nothing excludes that directory from ` +
              `platform backup on EITHER platform. Anything plaintext written there is carried ` +
              `to iCloud / Google Drive. Wire it into ${RUST_MODULE}'s EXCLUDED_DIRS and both ` +
              `Android rules files, map it in TRACKED_ACCESSORS, then roster its call sites.`,
          );
        }
      }
    }
  }

  // ── 1. The TS call sites match the roster, both directions ─────────────────
  const tsFiles = io.listTs(TS_ROOT);
  if (tsFiles.length === 0) {
    fail(`${TS_ROOT}: no .ts/.tsx files found — this guard is looking at the wrong tree`);
  }

  const accessorRe = new RegExp(`\\b(${Object.keys(TRACKED_ACCESSORS).join("|")})\\s*\\(`, "g");
  /** Call sites found on disk, as `file\0accessor` keys. */
  const found = new Set();
  for (const file of tsFiles) {
    const source = stripTsComments(io.read(file));
    for (const match of source.matchAll(accessorRe)) found.add(`${file}\0${match[1]}`);
  }

  const rosterKeys = new Set(ROSTER.map((entry) => `${entry.file}\0${entry.accessor}`));

  for (const key of found) {
    if (rosterKeys.has(key)) continue;
    const [file, accessor] = key.split("\0");
    const dir = TRACKED_ACCESSORS[accessor];
    fail(
      `${file}: calls \`${accessor}()\`, which is not on this guard's roster. ` +
        (dir === null
          ? `Nothing excludes that directory from platform backup on EITHER platform — ` +
            `anything plaintext written there is carried to iCloud / Google Drive. ` +
            `Wire it into ${RUST_MODULE}'s EXCLUDED_DIRS and both Android rules files, ` +
            `then add it to ROSTER with a reason.`
          : `Add it to ROSTER with a reason (the "${dir}" exclusion already covers it).`),
    );
  }

  for (const entry of ROSTER) {
    if (found.has(`${entry.file}\0${entry.accessor}`)) continue;
    fail(
      `ROSTER records \`${entry.accessor}()\` in ${entry.file}, but no such call exists. ` +
        `Remove the stale entry — a roster nobody prunes stops describing the tree.`,
    );
  }

  /** The directory names the tree actually writes into, from the roster. */
  const requiredDirs = new Set();
  for (const entry of ROSTER) {
    const dir = TRACKED_ACCESSORS[entry.accessor];
    if (dir === null || dir === undefined) {
      fail(
        `ROSTER records \`${entry.accessor}()\` in ${entry.file}, but TRACKED_ACCESSORS maps it ` +
          `to no directory — so no exclusion covers it. Map it and wire both platforms.`,
      );
      continue;
    }
    requiredDirs.add(dir);
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
      missing: "missing — Android 12+ has no backup exclusion",
      why: "Plaintext exports leave the device by that path.",
    },
    {
      file: ANDROID_RULES_LEGACY,
      blocks: ["full-backup-content"],
      missing: "missing — every Android <= 11 device backs the exports up",
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
        fail(`${file}: no <${name}> block — that copy path is unguarded`);
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
    "missing — nothing points Android at the backup rules",
  );
  if (manifestRaw !== null) {
    const manifest = stripXmlComments(manifestRaw);
    for (const [attr, resource, file, api] of ATTRS) {
      const match = manifest.match(new RegExp(`${attr}\\s*=\\s*"@xml/([A-Za-z0-9_]+)"`));
      if (!match) {
        fail(
          `${ANDROID_MANIFEST}: no \`${attr}\` on <application> — ${api} devices fall back ` +
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
            `"@xml/${resource}" — something outranked the library value.`,
        );
      }
    }
  }

  // ── 4. The iOS side: wired, and excluding the same directories ─────────────
  const rust = readOrFail(RUST_MODULE, "missing — iOS excludes nothing");
  if (rust !== null) {
    const decl = rust.match(/EXCLUDED_DIRS\s*:\s*&\[&str\]\s*=\s*&\[([^\]]*)\]/);
    if (!decl) {
      fail(`${RUST_MODULE}: could not find \`EXCLUDED_DIRS: &[&str] = &[…]\` — did it get renamed?`);
    } else {
      const iosDirs = new Set([...decl[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]));
      // Both directions: a directory the TS tree writes to and iOS does not
      // exclude is the bug; a directory iOS excludes that nothing writes to means
      // the two sides have drifted and one of them is describing a tree that is
      // no longer there.
      for (const dir of requiredDirs) {
        if (!iosDirs.has(dir)) {
          fail(
            `${RUST_MODULE}: EXCLUDED_DIRS omits "${dir}", which mobile/src writes plaintext to. ` +
              `iCloud Backup carries it.`,
          );
        }
      }
      for (const dir of iosDirs) {
        if (!requiredDirs.has(dir)) {
          fail(
            `${RUST_MODULE}: EXCLUDED_DIRS carries "${dir}", which no rostered call site writes to. ` +
              `Either the roster is stale or the iOS side is excluding the wrong directory.`,
          );
        }
      }
    }
    // Whether each EXCLUDED_DIRS entry has a resolver arm behind it is NOT
    // checked here on purpose: that is `backup_exclude::tests::every_excluded_dir_has_a_resolver`,
    // which fails `cargo test` on every platform. A text guard reading Rust
    // control flow would be the weaker of the two checks and the one that rots.
  }

  const setup = readOrFail(RUST_SETUP, "missing");
  if (setup !== null) {
    if (!/\bbackup_exclude::init\s*\(/.test(setup)) {
      fail(
        `${RUST_SETUP}: no \`backup_exclude::init(...)\` call. The module compiles, the guard's ` +
          `other checks pass, and iOS excludes nothing — the shipped-inert shape.`,
      );
    }
    if (!/^\s*mod backup_exclude;/m.test(setup)) {
      fail(`${RUST_SETUP}: \`mod backup_exclude;\` is not declared.`);
    }
  }

  return { failures, requiredDirs, callSites: ROSTER.length, mergedManifests: merged.length };
}

// ── Report ─────────────────────────────────────────────────────────────────
// Only when run directly, so importing this module for a spec has no side effect.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { failures, requiredDirs, callSites, mergedManifests } = analyse(diskIo());
  if (failures.length > 0) {
    console.error("mobile export-backup exclusion: FAILED");
    for (const message of failures) console.error(`  - ${message}`);
    console.error(
      "\n  Why this is a gate: a saved recovery phrase alone reconstructs the vault, so a copy\n" +
        "  of it in iCloud or Google Drive is a complete break of the zero-knowledge posture,\n" +
        "  reached without any adversary doing anything. See design-notes/security/0506-*.",
    );
    process.exit(1);
  }
  console.log(
    `mobile export-backup exclusion: ok (${callSites} export call sites, ` +
      `excluded dirs: ${[...requiredDirs].join(", ")}` +
      (mergedManifests > 0 ? `; ${mergedManifests} merged manifest(s) checked` : "") +
      `)`,
  );
}
