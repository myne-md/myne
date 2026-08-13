#!/usr/bin/env node
// npm dependency-license CI gate (MYND-504) — the npm analogue of cargo-deny.
//
// Fails the build on any transitive npm license outside the allowlist below,
// which MIRRORS deny.toml's `[licenses].allow` set (the Rust gate;
// docs/dependency-policy.md) plus a few npm-ecosystem-permissive additions and
// per-package exceptions, each documented inline. Closes the standing gap that
// cargo-deny machine-checks CARGO licenses only — the npm half of the tree was
// entirely ungated. Runs in CI (.woodpecker.yml `npm-licenses`) after install.
//
// SPDX expressions are evaluated structurally: an `OR` expression passes when
// ANY operand is allowed; an `AND` expression passes only when ALL operands are.
import { execSync } from "node:child_process";

// Mirror of deny.toml `[licenses].allow`, plus two npm-ecosystem additions:
//   0BSD       — BSD Zero-Clause; public-domain-equivalent (≡ CC0-1.0 / Unlicense,
//                which ARE on the Rust allowlist). Dep: tslib.
//   Python-2.0 — PSF license; permissive + GPL-compatible. Dep: argparse.
// AGPL-3.0 SPDX id variants are included for completeness (our own packages are
// AGPL-3.0; they aren't listed by `pnpm licenses list`, but this is harmless).
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
function isAllowed(expr) {
  const e = norm(expr);
  if (ALLOW.has(e)) return true;
  // SPDX operators are spec-mandated UPPERCASE and whitespace-delimited — anchor
  // on ` OR `/` AND ` (no /i) so the lowercase `or` in ids like `GPL-3.0-or-later`
  // is never mis-split.
  if (/\s+OR\s+/.test(e)) return e.split(/\s+OR\s+/).some(isAllowed);
  if (/\s+AND\s+/.test(e)) return e.split(/\s+AND\s+/).every(isAllowed);
  return false;
}

let raw;
try {
  raw = execSync("pnpm licenses list --json", {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  console.error(
    "npm-license gate: failed to run `pnpm licenses list --json`:",
    err.message,
  );
  process.exit(2);
}

const data = JSON.parse(raw);
const violations = [];
for (const [license, pkgs] of Object.entries(data)) {
  if (isAllowed(license)) continue;
  for (const p of pkgs) {
    if (EXCEPT.has(p.name)) continue;
    const vers = Array.isArray(p.versions) ? p.versions.join(",") : (p.version ?? "?");
    violations.push(`  ${p.name}@${vers} — ${license}`);
  }
}

if (violations.length > 0) {
  console.error(
    "npm-license gate FAILED — dependencies with a license outside the allowlist:\n" +
      violations.join("\n") +
      "\n\nIf the license is acceptable, add it to ALLOW (mirroring deny.toml) or add\n" +
      "the package to EXCEPT with a verified-license note in this script.",
  );
  process.exit(1);
}
console.log("npm-license gate: all dependency licenses are on the allowlist ✓");
