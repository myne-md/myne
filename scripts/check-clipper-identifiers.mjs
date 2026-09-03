#!/usr/bin/env node
// The browser clipper's three load-bearing identifiers, held across four files
// and two REPOSITORIES (myne-md/myne#558).
//
// The failure this prevents: every clipper pairing token binds to an extension
// ID, and the native-messaging host manifests are generated from these
// constants. Drift does not fail any build on either side — the desktop crate
// compiles, the extension loads, and the browser simply refuses to start the
// host for an origin nobody allowlisted. What the user sees is "clipping does
// nothing", with no error anywhere, and the fix is invisible from either
// repository alone.
//
//   1. `CHROMIUM_EXTENSION_ID`  ==  the id DERIVED from the extension's manifest
//                                   `key` (base64 → DER → SHA-256 → first 16
//                                   bytes → hex nibble `0..f` mapped to `a..p`)
//   2. `FIREFOX_EXTENSION_ID`   ==  the extension manifest's own gecko id
//   3. all three constants      ==  the values the root `CLAUDE.md`
//                                   load-bearing-identifiers table publishes
//   4. the generated manifests   reference the constants rather than literals
//
// # Why this guard did not exist, and why that is the interesting part
//
// myne-md/myne#558 states it plainly: the clipper's roster entries were derived
// when the companion repo was not in the checkout, so "every clipper entry was
// written against the desktop half only … the extension's own source, which is
// where the capture walk and the sanitisation actually live, was never read by
// anyone deriving the roster." `scripts/check-cli-sidecar.mjs` is the pattern
// for exactly this kind of cross-file agreement, and the issue notes that no
// equivalent existed for the clipper.
//
// # The cross-repo half REPORTS when it cannot run
//
// The companion is not in a fresh clone and not in CI. A guard that silently
// skipped its cross-repo checks there would report `ok` while checking half of
// what its name claims — which is precisely the failure
// `check-embed-layout-drift.mjs`'s header records about the published vectors
// ("both runners skip silently when the companion repo is absent, which is the
// default in CI and in a fresh clone"). So the absent case prints what it could
// NOT check, and `--require-companion` turns that into a failure for a caller
// that knows the companion is there.
//
// Zero dependencies, hand-runnable: node scripts/check-clipper-identifiers.mjs

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

/**
 * Where a `workspace/setup.sh` clone puts the companion.
 *
 * Resolved from the repo root rather than from this script's own location, so
 * it is the same path whether this runs from the main checkout or from a
 * worktree under `.claude/worktrees/`.
 *
 * `MYNE_CLIPPER_DIR` overrides it, and exists for one reason: the
 * companion-ABSENT branch is the branch that runs in CI and in a fresh clone,
 * and it is the one whose bug — reporting `ok` while checking half of what the
 * name claims — is invisible. Without an override there is no way to exercise
 * it on a machine that HAS the companion, which is every machine where anyone
 * would think to test this. `tests/scripts/clipperIdentifiers.test.ts` uses it.
 */
const COMPANION = process.env.MYNE_CLIPPER_DIR
  ? resolve(process.env.MYNE_CLIPPER_DIR)
  : resolve(repoRoot, "..", "..", "..", "myne-clipper");
const COMPANION_MANIFEST = join(COMPANION, "src", "manifest.json");

const MANIFEST_RS = "src-tauri/src/clipper/manifest.rs";
const CLAUDE_MD = "CLAUDE.md";

const failures = [];
const notes = [];
const fail = (message) => failures.push(message);

/** `pub const NAME: &str = "value";` out of a Rust source. */
function rustStrConst(source, where, name) {
  const m = source.match(new RegExp(`const\\s+${name}\\s*:\\s*&str\\s*=\\s*"([^"]*)"`));
  if (!m) {
    fail(
      `${where}: could not find \`const ${name}: &str = "…"\`. A renamed constant ` +
        `is not a smaller check — it is this guard reporting ok on an input it ` +
        `could not read.`,
    );
    return null;
  }
  return m[1];
}

/**
 * The Chromium extension ID a packed public key produces.
 *
 * Reimplemented here rather than trusted, because the whole point is to compare
 * the pinned constant against the derivation the browser itself performs. A
 * guard that read the constant from both sides would be comparing a value with
 * a copy of itself.
 */
function chromiumIdFromKey(base64Key) {
  const der = Buffer.from(base64Key, "base64");
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  // Each hex nibble `0..f` maps to `a..p`.
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

const manifestRs = read(MANIFEST_RS);
const chromiumId = rustStrConst(manifestRs, MANIFEST_RS, "CHROMIUM_EXTENSION_ID");
const firefoxId = rustStrConst(manifestRs, MANIFEST_RS, "FIREFOX_EXTENSION_ID");
const hostName = rustStrConst(manifestRs, MANIFEST_RS, "HOST_NAME");

// ── 1. Shape ────────────────────────────────────────────────────────────────
//
// Cheap, and it catches the one edit that looks harmless: a Chromium ID is 32
// characters from `[a-p]` by construction, so anything else was typed rather
// than derived.
if (chromiumId !== null && !/^[a-p]{32}$/.test(chromiumId)) {
  fail(
    `${MANIFEST_RS}: CHROMIUM_EXTENSION_ID is "${chromiumId}", which is not 32 ` +
      `characters of [a-p]. A Chromium extension ID is derived from a key, so a ` +
      `value outside that alphabet cannot be one — it was typed.`,
  );
}
if (firefoxId !== null && !firefoxId.includes("@")) {
  fail(
    `${MANIFEST_RS}: FIREFOX_EXTENSION_ID is "${firefoxId}". A Gecko extension id ` +
      `is either an email-shaped string or a GUID in braces; this is neither.`,
  );
}

// ── 2. The root CLAUDE.md table publishes these values ──────────────────────
//
// That table is normative prose — a reader takes the value from it — and it is
// the one place the three appear together. A constant changed without the table
// leaves a published identifier that is wrong, in a document whose whole purpose
// is being the reference.
const claudeMd = read(CLAUDE_MD);
for (const [name, value] of [
  ["CHROMIUM_EXTENSION_ID", chromiumId],
  ["FIREFOX_EXTENSION_ID", firefoxId],
  ["HOST_NAME", hostName],
]) {
  if (value === null) continue;
  // Matched with a BOUNDARY, not as a substring. `includes("md.myne.clipper")`
  // is satisfied by `md.myne.clipper-OLD`, so a table entry edited to a
  // longer string containing the old one passed — which is precisely the
  // superseded-value case this check exists for, and it was found by injecting
  // exactly that (`tests/scripts/clipperIdentifiers.test.ts`).
  //
  // The table writes each value in backticks, so requiring the occurrence not
  // to be followed by an identifier-ish character is enough and does not
  // depend on the surrounding prose.
  const bounded = new RegExp(
    `${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9._@-])`,
  );
  if (!bounded.test(claudeMd)) {
    fail(
      `${CLAUDE_MD}: the load-bearing-identifiers table does not carry ${name}'s ` +
        `current value "${value}". Changing one of these forces a re-pair on every ` +
        `distributed install, and the table is where that is published.`,
    );
  }
}

// ── 3. The generated manifests reference the constants ──────────────────────
//
// A manifest builder that inlined a literal would keep working and stop
// tracking the constant — the drift class this guard exists for, one file
// closer in.
for (const [needle, why] of [
  ["FIREFOX_EXTENSION_ID", "the Firefox manifest's allowed_extensions"],
  ["CHROMIUM_EXTENSION_ID", "the Chromium manifest's allowed_origins"],
  ["HOST_NAME", "the host rendezvous name both manifests carry"],
]) {
  // Counted rather than merely found: the declaration itself is one occurrence,
  // so a constant that is declared and never USED reads as present.
  const uses = manifestRs.split(needle).length - 1;
  if (uses < 2) {
    fail(
      `${MANIFEST_RS}: ${needle} is declared and never used (${uses} occurrence). ` +
        `${why} would then be carrying a literal, which stops tracking the ` +
        `constant the pairing token binds to.`,
    );
  }
}

// ── 4. The cross-REPO half ──────────────────────────────────────────────────
const requireCompanion = process.argv.includes("--require-companion");
if (!existsSync(COMPANION_MANIFEST)) {
  const message =
    `the myne-clipper companion is not checked out at ${COMPANION}, so the ` +
    `DERIVATION of CHROMIUM_EXTENSION_ID from the extension's own manifest key ` +
    `was NOT checked — which is the half no single repository can verify. ` +
    `Clone it with ./workspace/setup.sh, or pass --require-companion to make ` +
    `this a failure.`;
  if (requireCompanion) fail(message);
  else notes.push(message);
} else {
  let extManifest = null;
  try {
    extManifest = JSON.parse(readFileSync(COMPANION_MANIFEST, "utf8"));
  } catch (e) {
    fail(`${COMPANION_MANIFEST}: could not be parsed as JSON (${String(e)})`);
  }

  if (extManifest !== null) {
    const key = extManifest.key;
    if (typeof key !== "string") {
      fail(
        `${COMPANION_MANIFEST}: no \`key\` field. The committed key is what makes ` +
          `a keyed unpacked install and a future Web Store build share one ID; ` +
          `without it the ID pinned on this side is unverifiable.`,
      );
    } else {
      const derived = chromiumIdFromKey(key);
      if (chromiumId !== null && derived !== chromiumId) {
        fail(
          `CHROMIUM_EXTENSION_ID drift: ${MANIFEST_RS} pins "${chromiumId}", but the ` +
            `extension's committed key derives "${derived}". Every distributed ` +
            `pairing token binds to the pinned value, and the browser will only ` +
            `start the native host for the derived one — so clipping does nothing, ` +
            `with no error on either side.`,
        );
      }
    }

    const gecko =
      extManifest.browser_specific_settings?.gecko?.id ?? extManifest.applications?.gecko?.id;
    if (typeof gecko !== "string") {
      notes.push(
        `${COMPANION_MANIFEST}: no gecko id declared, so FIREFOX_EXTENSION_ID could ` +
          `not be cross-checked (Firefox derives one at install time when the ` +
          `manifest omits it, which is exactly what pinning here prevents).`,
      );
    } else if (firefoxId !== null && gecko !== firefoxId) {
      fail(
        `FIREFOX_EXTENSION_ID drift: ${MANIFEST_RS} pins "${firefoxId}", the ` +
          `extension declares "${gecko}". The host manifest's allowed_extensions is ` +
          `generated from the pinned value, so Firefox refuses to start the host.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("clipper identifiers: FAILED");
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
for (const note of notes) console.warn(`clipper identifiers: NOT CHECKED — ${note}`);
console.log(
  `clipper identifiers: ok (host "${hostName}", chromium "${chromiumId}", ` +
    `firefox "${firefoxId}"${notes.length === 0 ? ", derivation verified against the companion" : ""})`,
);
