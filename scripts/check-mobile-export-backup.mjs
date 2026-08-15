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
// NOT tracked, deliberately: `appDataDir()` / `appCacheDir()` /
// `appLocalDataDir()`. Those are app-private and hold the AEAD-encrypted vault,
// which is *meant* to be in a backup — that is a genuine safety net for a user
// who does not sync, and it discloses nothing. This guard is about plaintext
// leaving the device by a route the user never chose.
//
// Zero dependencies, hand-runnable: node scripts/check-mobile-export-backup.mjs

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

// ── Paths of the four sides ────────────────────────────────────────────────
const TS_ROOT = "mobile/src";
const RUST_MODULE = "mobile/src-tauri/src/backup_exclude.rs";
const RUST_SETUP = "mobile/src-tauri/src/lib.rs";
const ANDROID_MANIFEST = "mobile/android-widgets/src/main/AndroidManifest.xml";
const ANDROID_RULES_MODERN = "mobile/android-widgets/src/main/res/xml/myne_backup_rules.xml";
const ANDROID_RULES_LEGACY = "mobile/android-widgets/src/main/res/xml/myne_backup_rules_legacy.xml";

/**
 * `@tauri-apps/api/path` accessors that resolve to a DEVICE-VISIBLE directory —
 * one the platform backs up and the user can plausibly reach — mapped to the
 * directory name the Android backup rules and the iOS roster use.
 *
 * `null` means "no exclusion is wired for this accessor at all": using it is an
 * egress channel that nothing closes, so the guard fails and the author has to
 * either wire it on both platforms or argue for it in review. That is the point
 * of listing accessors nobody calls today.
 */
const TRACKED_ACCESSORS = {
  documentDir: "Documents",
  downloadDir: null,
  pictureDir: null,
  publicDir: null,
  audioDir: null,
  videoDir: null,
  homeDir: null,
  desktopDir: null,
};

/**
 * The recorded roster: every device-visible-directory call site in `mobile/src`,
 * with why it is legitimate. A site absent here fails; a recorded site that no
 * longer exists fails too (a roster nobody prunes stops being a roster).
 */
const ROSTER = [
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

const failures = [];
const fail = (message) => failures.push(message);

// ── 1. The TS call sites match the roster, both directions ─────────────────
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const tsRootAbs = join(repoRoot, TS_ROOT);
if (!existsSync(tsRootAbs)) {
  fail(`${TS_ROOT}: not found — this guard is looking at the wrong tree`);
}

/** Call sites found on disk, as `file\0accessor` keys. */
const found = new Map();
if (existsSync(tsRootAbs)) {
  const accessorRe = new RegExp(`\\b(${Object.keys(TRACKED_ACCESSORS).join("|")})\\s*\\(`, "g");
  for (const abs of walk(tsRootAbs)) {
    const rel = relative(repoRoot, abs).split("\\").join("/");
    const source = readFileSync(abs, "utf8");
    for (const match of source.matchAll(accessorRe)) {
      const key = `${rel}\0${match[1]}`;
      if (!found.has(key)) found.set(key, { file: rel, accessor: match[1] });
    }
  }
}

const rosterKeys = new Set(ROSTER.map((e) => `${e.file}\0${e.accessor}`));

for (const [key, site] of found) {
  if (rosterKeys.has(key)) continue;
  const dir = TRACKED_ACCESSORS[site.accessor];
  fail(
    `${site.file}: calls \`${site.accessor}()\`, which is not on this guard's roster. ` +
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
  if (dir === null) {
    fail(
      `ROSTER records \`${entry.accessor}()\` in ${entry.file}, but TRACKED_ACCESSORS maps it ` +
        `to no directory — so no exclusion covers it. Map it and wire both platforms.`,
    );
    continue;
  }
  if (dir !== undefined) requiredDirs.add(dir);
}

// ── 2. The Android rules exclude every required dir, in every block ─────────
/**
 * Drop XML comments before any structural match.
 *
 * Load-bearing, and it was found by break-testing rather than by reading: these
 * files DOCUMENT the elements they contain, so `<device-transfer>` appears in a
 * comment above the real one. Without this, `block()` anchored on the comment's
 * mention, ran its lazy body to the real closing tag, and swallowed the
 * `<cloud-backup>` block whole — so a `<device-transfer>` emptied of its
 * `<exclude>` still "contained" one and the guard passed. The same shape would
 * hide a missing manifest attribute mentioned in prose.
 */
const stripComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, "");

/** `<exclude domain="..." path="..."/>` entries inside one XML block. */
function excludedPaths(xml) {
  const dirs = new Set();
  for (const match of xml.matchAll(/<exclude\b[^>]*\/?>/g)) {
    const domain = match[0].match(/domain\s*=\s*"([^"]*)"/);
    const path = match[0].match(/path\s*=\s*"([^"]*)"/);
    if (domain?.[1] === "external" && path) dirs.add(path[1].replace(/\/+$/, ""));
  }
  return dirs;
}

/** The text between `<name>` and `</name>`, or null. */
function block(xml, name) {
  const match = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return match ? match[1] : null;
}

if (!existsSync(join(repoRoot, ANDROID_RULES_MODERN))) {
  fail(`${ANDROID_RULES_MODERN}: missing — Android 12+ has no backup exclusion`);
} else {
  const xml = stripComments(read(ANDROID_RULES_MODERN));
  // BOTH blocks, not one: device transfer is a separate copy path that ignores
  // the cloud-backup block entirely.
  for (const name of ["cloud-backup", "device-transfer"]) {
    const body = block(xml, name);
    if (body === null) {
      fail(`${ANDROID_RULES_MODERN}: no <${name}> block — that copy path is unguarded`);
      continue;
    }
    const excluded = excludedPaths(body);
    for (const dir of requiredDirs) {
      if (!excluded.has(dir)) {
        fail(
          `${ANDROID_RULES_MODERN}: <${name}> does not exclude ` +
            `domain="external" path="${dir}". Plaintext exports leave the device by that path.`,
        );
      }
    }
  }
}

if (!existsSync(join(repoRoot, ANDROID_RULES_LEGACY))) {
  fail(`${ANDROID_RULES_LEGACY}: missing — every Android <= 11 device backs the exports up`);
} else {
  const xml = stripComments(read(ANDROID_RULES_LEGACY));
  const body = block(xml, "full-backup-content");
  if (body === null) {
    fail(`${ANDROID_RULES_LEGACY}: no <full-backup-content> root — API <= 30 reads nothing`);
  } else {
    const excluded = excludedPaths(body);
    for (const dir of requiredDirs) {
      if (!excluded.has(dir)) {
        fail(
          `${ANDROID_RULES_LEGACY}: does not exclude domain="external" path="${dir}". ` +
            `android:dataExtractionRules is ignored below API 31, so this file is the ` +
            `only exclusion pre-Android-12 devices read.`,
        );
      }
    }
  }
}

// ── 3. The library manifest declares both attributes, at real resources ─────
if (!existsSync(join(repoRoot, ANDROID_MANIFEST))) {
  fail(`${ANDROID_MANIFEST}: missing — nothing points Android at the backup rules`);
} else {
  const manifest = stripComments(read(ANDROID_MANIFEST));
  const attrs = [
    ["android:dataExtractionRules", "myne_backup_rules", ANDROID_RULES_MODERN, "API 31+"],
    ["android:fullBackupContent", "myne_backup_rules_legacy", ANDROID_RULES_LEGACY, "API <= 30"],
  ];
  for (const [attr, resource, file, api] of attrs) {
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
    if (!existsSync(join(repoRoot, file))) {
      fail(`${ANDROID_MANIFEST}: \`${attr}\` points at "@xml/${resource}", which does not exist.`);
    }
  }
}

// ── 4. The iOS side: wired, and excluding the same directories ─────────────
if (!existsSync(join(repoRoot, RUST_MODULE))) {
  fail(`${RUST_MODULE}: missing — iOS excludes nothing`);
} else {
  const rust = read(RUST_MODULE);
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
}

if (!existsSync(join(repoRoot, RUST_SETUP))) {
  fail(`${RUST_SETUP}: missing`);
} else {
  const setup = read(RUST_SETUP);
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

// ── Report ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error("mobile export-backup exclusion: FAILED");
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(
  `mobile export-backup exclusion: ok (${ROSTER.length} export call sites, ` +
    `excluded dirs: ${[...requiredDirs].join(", ")})`,
);
