#!/usr/bin/env node
// npm dependency-license CI gate (MYND-504) — the npm analogue of cargo-deny.
//
// Fails the build on any transitive npm license outside the allowlist below,
// which MIRRORS deny.toml's `[licenses].allow` set (the Rust gate;
// docs/dependency-policy.md) plus a few npm-ecosystem-permissive additions and
// per-package exceptions, each documented inline. Closes the standing gap that
// cargo-deny machine-checks CARGO licenses only — the npm half of the tree was
// entirely ungated. Runs in CI (.woodpecker/main.yml `npm-licenses`) after install.
//
// SPDX expressions are evaluated structurally: an `OR` expression passes when
// ANY operand is allowed; an `AND` expression passes only when ALL operands are.
//
// ── EXIT CODES, and the distinction is the point (myne-md/myne#515) ──────────
//
//   0  every dependency's license is on the allowlist
//   1  a FINDING: at least one dependency is outside it
//   2  the gate COULD NOT EVALUATE: pnpm would not run, or answered with
//      something this script cannot read, or answered with a tree too small to
//      be the real one
//
// 1 and 2 are different events and must stay different. A gate that could not
// run is not a gate, and reporting it as a policy finding sends the reader
// looking for a license that does not exist. This file used to draw that line
// correctly and say so nowhere, which is how the next edit collapses it.
//
// ── WHERE THE STORE COMES FROM, and why this script has to be told ───────────
//
// `pnpm licenses list` builds its answer from the LOCKFILE plus the
// content-addressable STORE, not from a walked `node_modules`. So it needs to
// be pointed at the same store the install used — and it REJECTS `--store-dir`
// ("Unknown option: 'store-dir'"), which is why `--config.store-dir=` is the
// spelling below. The env form `npm_config_store_dir` was measured and does not
// work either.
//
// That asymmetry is what myne#515 was: CI ran
// `pnpm install --frozen-lockfile --store-dir /cache/cargo/pnpm-store` and then
// this script with no store at all, so pnpm looked in the default store, found
// nothing, and answered ERR_PNPM_MISSING_PACKAGE_INDEX_FILE on every run for
// months. The whole mobile test tier is downstream of this step and was skipped
// with it.
//
// The path is a PARAMETER rather than something this script assumes, because
// the assumption is the bug. `--store-dir` is optional and absent means "use
// whatever store pnpm resolves", so a hand-run at a normal $HOME is unchanged.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Mirror of deny.toml `[licenses].allow`, plus three npm-ecosystem additions:
//   0BSD       — BSD Zero-Clause; public-domain-equivalent (≡ CC0-1.0 / Unlicense,
//                which ARE on the Rust allowlist). Dep: tslib.
//   Python-2.0 — PSF license; permissive + GPL-compatible. Dep: argparse.
//   BlueOak-1.0.0 — see its own note below.
// AGPL-3.0 SPDX id variants are included for completeness (our own packages are
// AGPL-3.0; they aren't listed by `pnpm licenses list`, but this is harmless).
//
// The mirror is asserted here and machine-checked NOWHERE, and it has already
// drifted: deny.toml carries `CDLA-Permissive-2.0` (webpki-roots, with its own
// note there) and this list does not. Latent today because that is a Rust-side
// license, and filed rather than fixed here.
const ALLOW = new Set([
  "AGPL-3.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
  "0BSD",
  "Python-2.0",
  // BlueOak-1.0.0 — the Blue Oak Model License 1.0.0, OSI-approved and
  // permissive with no copyleft, so AGPL-compatible like every other entry here.
  // Deps: the `isaacs` tooling family (glob, minimatch, lru-cache, minipass,
  // path-scurry). Third npm-ecosystem addition, and the one with a story: this
  // gate lived in `myne-mobile/scripts/` and walked only the mobile client's
  // dependency tree, so the DESKTOP and WEB npm trees had never been license-
  // gated at all — the five packages above sat in them, ungated, the whole time.
  // Folding the mobile client in-repo left one lockfile and one node_modules,
  // which is what made a workspace-wide run possible and turned them up. The
  // dependencies are not new; the gate over them is.
  "BlueOak-1.0.0",
]);

// Per-package exceptions — verified-permissive but NOT machine-detectable by
// `pnpm licenses list` (empty / nonstandard `license` field), the npm analogue
// of deny.toml's `[licenses].exceptions` escape hatch.
//   khroma — MIT (github.com/fabiospampinato/khroma, LICENSE file present) but
//            published without a package.json `license` field, so pnpm reports
//            "Unknown". Pulled in transitively by mermaid.
const EXCEPT = new Set(["khroma"]);

const norm = (s) => s.trim().replace(/^\(+|\)+$/g, "").trim();
export function isAllowed(expr) {
  const e = norm(expr);
  if (ALLOW.has(e)) return true;
  // SPDX operators are spec-mandated UPPERCASE and whitespace-delimited — anchor
  // on ` OR `/` AND ` (no /i) so the lowercase `or` in ids like `GPL-3.0-or-later`
  // is never mis-split.
  if (/\s+OR\s+/.test(e)) return e.split(/\s+OR\s+/).some(isAllowed);
  if (/\s+AND\s+/.test(e)) return e.split(/\s+AND\s+/).every(isAllowed);
  return false;
}

/** Thrown for every "the gate could not evaluate" condition; maps to exit 2. */
export class GateCannotRun extends Error {}

/**
 * The pure half: classify an already-parsed `pnpm licenses list --json` payload.
 *
 * Split out from the IO so the cases below can be injected under `vitest`
 * (`tests/scripts/npmLicenses.test.ts`), the same shape
 * `scripts/check-mobile-export-backup.mjs` uses with `analyse(io)`. A guard
 * whose only exercise is CI passing is a guard nobody has tested.
 *
 * Throws {@link GateCannotRun} for a payload it cannot read. It never treats an
 * unreadable payload as "no violations".
 */
export function classify(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new GateCannotRun(
      `expected a {license: [packages]} object, got ${Array.isArray(data) ? "an array" : typeof data}`,
    );
  }
  // pnpm reports its own failures as `{"error": {"code": ..., "message": ...}}`
  // ON STDOUT. Today that arrives with a non-zero exit so the caller's catch
  // fires first, but nothing guarantees that pairing: were it ever to arrive at
  // exit 0, `isAllowed("error")` is false and `for (const p of pkgs)` would
  // throw "is not iterable" — a stack trace wearing the costume of a finding.
  if ("error" in data) {
    const e = data.error;
    throw new GateCannotRun(
      `pnpm answered with an error payload: ${e?.code ?? "?"} — ${e?.message ?? JSON.stringify(e)}`,
    );
  }

  const violations = [];
  const seen = new Set();
  for (const [license, pkgs] of Object.entries(data)) {
    if (!Array.isArray(pkgs)) {
      throw new GateCannotRun(
        `the value under "${license}" is ${typeof pkgs}, not an array of packages`,
      );
    }
    for (const p of pkgs) {
      if (typeof p?.name === "string") seen.add(p.name);
    }
    if (isAllowed(license)) continue;
    for (const p of pkgs) {
      if (EXCEPT.has(p.name)) continue;
      const vers = Array.isArray(p.versions) ? p.versions.join(",") : (p.version ?? "?");
      violations.push(`  ${p.name}@${vers} — ${license}`);
    }
  }
  return { violations, seen };
}

/**
 * Every direct dependency declared anywhere in the workspace.
 *
 * This is the gate's DENOMINATOR, and it is computed rather than recorded on
 * purpose. A recorded package count would need re-baselining on every
 * dependency change, which is how a ratchet decays first into a nuisance and
 * then into a rubber stamp; `check-twin-inventory.mjs` computes its denominator
 * for the same reason.
 *
 * Excluded, because none of them appears in a licenses payload:
 *   `workspace:` / `link:` / `file:` — our own packages and local paths
 *   `catalog:`                       — resolved through the catalog, listed
 *                                      under its real name if it resolves
 *   optionalDependencies             — may legitimately not be installed
 */
export function declaredDirectDeps(readJson, roots) {
  const names = new Set();
  for (const root of roots) {
    const pkg = readJson(root);
    if (!pkg) continue;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (typeof spec === "string" && /^(workspace|link|file|catalog):/.test(spec)) continue;
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * The vacuity floor: prove the payload describes the tree it claims to gate.
 *
 * The failure this exists for is strictly worse than myne#515's, because it is
 * GREEN. With `data = {}` the classification loop runs zero times, `violations`
 * is empty, and this script printed "all dependency licenses are on the
 * allowlist ✓" and exited 0 — a gate reporting success while checking nothing.
 * `.woodpecker/main.yml` and `check-e2e-floor.mjs` both already say, in as many
 * words, that a gate which did not run is indistinguishable from one that
 * passed; that reasoning applies to a gate which ran over nothing.
 */
export function assertNotVacuous(seen, declared) {
  const missing = [...declared].filter((n) => !seen.has(n)).sort();
  if (missing.length === 0) return;
  throw new GateCannotRun(
    `the payload is missing ${missing.length} of ${declared.size} directly-declared ` +
      `dependencies, so it does not describe this workspace:\n` +
      missing.slice(0, 12).map((n) => `    ${n}`).join("\n") +
      (missing.length > 12 ? `\n    … and ${missing.length - 12} more` : ""),
  );
}

// ── IO from here down ────────────────────────────────────────────────────────

function die(message) {
  console.error(
    `npm-license gate: COULD NOT EVALUATE — this is not a license finding.\n\n  ${message}\n\n` +
      `Nothing was checked, so a green run before this one says nothing about the\n` +
      `tree as it is now. Exit 2 means exactly this; exit 1 is a real violation.`,
  );
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--store-dir");
  const storeDir = i === -1 ? null : argv[i + 1];
  if (i !== -1 && !storeDir) die("--store-dir was given with no path after it");

  // `--config.<setting>` rather than `--store-dir`: the licenses subcommand
  // rejects the latter outright. Do not "simplify" this to `--store-dir` and do
  // not replace it with the `npm_config_store_dir` env var; both were measured
  // and neither works. See the header.
  const args = ["licenses", "list", "--json"];
  if (storeDir) args.push(`--config.store-dir=${storeDir}`);

  let raw;
  try {
    raw = execFileSync("pnpm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // pnpm writes its failure object to STDOUT under `--json`, and leaves stderr
    // empty. `err.message` is the useless `Command failed: …`, which is all this
    // script used to print and all CI ever logged — the diagnosis was sitting in
    // `err.stdout` and being discarded. Same shape as
    // `scripts/check-test-typecheck.mjs`, where tsc likewise reports on stdout.
    const payload = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    let store = "unknown";
    try {
      store = execFileSync("pnpm", ["store", "path"], { encoding: "utf8" }).trim();
    } catch {
      // Best effort. If even this fails, pnpm itself is the problem and the
      // exit status below already says so.
    }
    die(
      `\`pnpm ${args.join(" ")}\` exited ${err.status ?? "?"}.\n` +
        `  pnpm's own output:\n    ${payload === "" ? "(nothing on stdout or stderr)" : payload.replace(/\n/g, "\n    ")}\n` +
        `  active store: ${store}\n` +
        `  store asked for: ${storeDir ?? "(none passed; pnpm resolved its own)"}\n\n` +
        `  If that is ERR_PNPM_MISSING_PACKAGE_INDEX_FILE, the install and this\n` +
        `  gate are looking at different stores — pass the install's --store-dir\n` +
        `  value to this script too.`,
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // Reached when pnpm exits 0 with something that is not JSON — measured:
    // `pnpm licenses list --json --filter <member>` exits 0 with an EMPTY
    // string. Unguarded this was an uncaught SyntaxError and Node's exit 1,
    // i.e. indistinguishable from a real license violation.
    die(
      `pnpm exited 0 but its output is not JSON (${err.message}).\n` +
        `  first 200 bytes: ${JSON.stringify(raw.slice(0, 200))}`,
    );
  }

  let result;
  try {
    result = classify(data);
    assertNotVacuous(
      result.seen,
      declaredDirectDeps(
        (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null),
        workspacePackageJsonPaths(),
      ),
    );
  } catch (err) {
    if (err instanceof GateCannotRun) die(err.message);
    throw err;
  }

  if (result.violations.length > 0) {
    console.error(
      "npm-license gate FAILED — dependencies with a license outside the allowlist:\n" +
        result.violations.join("\n") +
        "\n\nIf the license is acceptable, add it to ALLOW (mirroring deny.toml) or add\n" +
        "the package to EXCEPT with a verified-license note in this script.",
    );
    process.exit(1);
  }
  console.log(
    `npm-license gate: all dependency licenses are on the allowlist ✓ ` +
      `(${result.seen.size} package(s) seen)`,
  );
}

/** Root `package.json` plus each pnpm-workspace member's. */
function workspacePackageJsonPaths() {
  const root = process.cwd();
  const paths = [join(root, "package.json")];
  const ws = join(root, "pnpm-workspace.yaml");
  if (existsSync(ws)) {
    // A deliberately small reader rather than a YAML dependency: this file is a
    // flat `packages:` list of literal directory names, and adding a parser to
    // a zero-dependency guard is a worse trade than reading the shape we own.
    for (const line of readFileSync(ws, "utf8").split("\n")) {
      const m = line.match(/^\s*-\s*["']?([^"'#\s]+)["']?\s*$/);
      if (m) paths.push(join(root, m[1], "package.json"));
    }
  }
  return paths;
}

// `import.meta.main` is Node 24+; the `process.argv[1]` compare is what the
// other guards here use and works under `node scripts/…` and `vitest` alike.
if (process.argv[1] && process.argv[1].endsWith("check-npm-licenses.mjs")) main();
