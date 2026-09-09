#!/usr/bin/env node
// The npm license allowlist claims to mirror deny.toml's `[licenses].allow`, and
// until this guard existed that claim was prose backed by nothing (myne#527).
//
// # The failure this prevents
//
// Two committed files, one asserting a relationship to the other in a comment.
// Nothing in the toolchain relates them: `cargo deny` reads deny.toml,
// `check-npm-licenses.mjs` reads its own ALLOW set, and a license added on one
// side (deny.toml gained `CDLA-Permissive-2.0` for webpki-roots in e194df44)
// simply never reached the other. The drift was latent — a Rust-side license
// no npm package needed — which is the worst shape: the next reader is told a
// relationship that does not hold, and the drift that eventually matters looks
// exactly like the drift that does not.
//
// This is the same shape as `check-embed-layout-drift.mjs`: one narrow
// cross-file agreement, compared in BOTH directions, failing by name when
// either side is renamed away rather than reporting ok on an input it could
// not find.
//
// # What the comparison is
//
// deny.toml's `[licenses].allow` is the Rust-side policy set. The npm ALLOW
// set must contain every entry of it, plus a SMALL named list of npm-only
// additions, each carrying a written reason (the license-adding equivalent of
// `check-ipc-binding-callers.mjs`'s reason-carrying exemptions: an addition
// nobody can explain is exactly the one a reviewer would have refused).
//
// Both directions, because a one-directional check is how a roster ends up
// compared against a second copy of itself (myne#506, and the one-way matrix
// that motivated myne#587):
//   - in deny.toml but not npm ALLOW: the mirror is broken, or the entry was
//     forgotten (this is myne#527's own defect shape).
//   - in npm ALLOW but neither in deny.toml nor in NPM_ONLY: an undocumented
//     addition nobody argued for.
//
// Zero dependencies, hand-runnable: node scripts/check-npm-license-mirror.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DENY_FILE = "deny.toml";
const NPM_FILE = "scripts/check-npm-licenses.mjs";

/** npm-ecosystem licenses deliberately NOT on the Rust allowlist, each with the
 *  reason it is acceptable here. Anything on this list but absent from the
 *  script's ALLOW set is fine (the mirror is a superset); anything added to
 *  ALLOW without joining this list fails the run. */
const NPM_ONLY = new Map([
  [
    "0BSD",
    "BSD Zero-Clause; public-domain-equivalent (≡ CC0-1.0 / Unlicense, which ARE on the Rust allowlist). Dep: tslib.",
  ],
  ["Python-2.0", "PSF license; permissive + GPL-compatible. Dep: argparse."],
  [
    "BlueOak-1.0.0",
    "Blue Oak Model License 1.0.0, OSI-approved and permissive with no copyleft. Deps: the isaacs tooling family.",
  ],
  [
    "AGPL-3.0-only",
    "SPDX id variant of our own AGPL-3.0 policy; harmless (pnpm licenses list does not list our workspace packages).",
  ],
  [
    "AGPL-3.0-or-later",
    "SPDX id variant of our own AGPL-3.0 policy; harmless (pnpm licenses list does not list our workspace packages).",
  ],
]);

/** Extract deny.toml's `[licenses].allow` array as a Set of quoted strings.
 *  Comment lines inside the array (TOML `#`) are stripped first: the webpki
 *  entry carries a five-line inline rationale, and a naive quoted-string scan
 *  reads prose fragments out of it as if they were licenses. */
export function parseDenyAllow(text) {
  const section = /\[licenses\][^\[]*?allow\s*=\s*\[([^\]]*)\]/.exec(text);
  if (section === null) {
    return { error: "deny.toml has no [licenses].allow array this parser can read." };
  }
  const entries = new Set();
  for (const line of section[1].split("\n")) {
    const stripped = line.replace(/#.*$/, "");
    for (const m of stripped.matchAll(/"([^"]+)"/g)) entries.add(m[1]);
  }
  return { entries };
}

/** Extract the ALLOW set from check-npm-licenses.mjs as an ordered list. */
export function parseNpmAllow(text) {
  const block = /const ALLOW = new Set\(\[([\s\S]*?)\]\);/.exec(text);
  if (block === null) {
    return { error: "check-npm-licenses.mjs has no `const ALLOW = new Set([...])` block." };
  }
  const entries = new Set();
  for (const m of block[1].matchAll(/"([^"]+)"/g)) entries.add(m[1]);
  return { entries };
}

const failures = [];

function read(rel) {
  try {
    return readFileSync(join(repoRoot, rel), "utf8");
  } catch {
    failures.push(`${rel}: not found. This guard is looking at the wrong tree.`);
    return null;
  }
}

const denyText = read(DENY_FILE);
const npmText = read(NPM_FILE);
const deny = denyText === null ? null : parseDenyAllow(denyText);
const npm = npmText === null ? null : parseNpmAllow(npmText);

if (deny !== null && deny.error !== undefined) failures.push(`${DENY_FILE}: ${deny.error}`);
if (npm !== null && npm.error !== undefined) failures.push(`${NPM_FILE}: ${npm.error}`);

if (deny?.entries && npm?.entries) {
  if (deny.entries.size === 0) {
    failures.push(`${DENY_FILE}: parsed an EMPTY allow list. The parser is broken, not the policy.`);
  }
  if (npm.entries.size === 0) {
    failures.push(`${NPM_FILE}: parsed an EMPTY ALLOW set. The parser is broken, not the policy.`);
  }

  for (const license of deny.entries) {
    if (!npm.entries.has(license)) {
      failures.push(
        `${license} is in ${DENY_FILE} [licenses].allow but NOT in the npm ALLOW set ` +
          `(${NPM_FILE}). The npm set claims to mirror the Rust one; add the entry.`,
      );
    }
  }
  for (const license of npm.entries) {
    if (deny.entries.has(license)) continue;
    if (NPM_ONLY.has(license)) continue;
    failures.push(
      `${license} is in the npm ALLOW set (${NPM_FILE}) but neither in ${DENY_FILE} ` +
        `[licenses].allow nor on this guard's NPM_ONLY list. An undocumented addition: ` +
        `either mirror it in deny.toml or add it to NPM_ONLY in ` +
        `scripts/check-npm-license-mirror.mjs with a written reason.`,
    );
  }
  for (const [license, reason] of NPM_ONLY) {
    if (npm.entries.has(license)) continue;
    failures.push(
      `${license} is on this guard's NPM_ONLY list with the reason "${reason}", ` +
        `but the npm ALLOW set no longer carries it. Delete the stale NPM_ONLY entry.`,
    );
  }
}

if (failures.length > 0) {
  console.error("npm-license-mirror: FAILED");
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(
  `npm-license-mirror: ok (${deny.entries.size} deny.toml entries mirrored, ` +
    `${npm.entries.size} ALLOW entries, ${NPM_ONLY.size} documented npm-only additions)`,
);
