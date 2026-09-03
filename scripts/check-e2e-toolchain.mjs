#!/usr/bin/env node
// The E2E container image's Rust version must match `rust-toolchain.toml`.
//
// THE FAILURE THIS PREVENTS, which really happened. `e2e/Dockerfile` sat at
// `rust:1.90.0-slim` against a `channel = "1.96.0"` pin. Nothing failed to
// build, nothing warned: rustup simply provisioned the pinned toolchain at
// runtime, inside whichever scenario happened to make the first cargo call —
// about two minutes, on every container, forever.
//
// Slow is the benign reading. Rustup's partial install state is not crash-safe,
// and one run raced it into
//   error: failed to install component … detected conflict
//   error: the 'cargo' binary … is not applicable to the '1.96.0-…' toolchain
// after which `cargo build -p e2e-fixture-gen` failed inside each scenario's own
// timeout. The suite reported 255 FAILURES in 266 s. 245 of them were that one
// infrastructure error wearing a test's name, and the report gave no hint of it
// — the kind of number that gets read as "the branch broke everything".
//
// A version mismatch is invisible to every compiler and every other check here,
// which is why it needs its own. Two integers, compared.
//
// SECOND CHECK, added by myne-md/myne#555: the RUNTIME PACKAGE SET. CI does not
// build `e2e/Dockerfile` — its `e2e` / `e2e-quarantine` steps apt-install their
// own list onto a bare rust image, so the two seats are two hand-maintained
// package lists that nothing compares. See the block at the bottom of this file.
//
//   node scripts/check-e2e-toolchain.mjs

import { woodpeckerConfigPaths } from "./lib/woodpecker-configs.mjs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const pin = readFileSync(join(ROOT, "rust-toolchain.toml"), "utf8");
const channel = /^\s*channel\s*=\s*"([^"]+)"/m.exec(pin)?.[1];
if (!channel) {
  console.error("check-e2e-toolchain: no `channel` in rust-toolchain.toml");
  process.exit(1);
}

const dockerfile = readFileSync(join(ROOT, "e2e/Dockerfile"), "utf8");
const from = /^FROM\s+rust:([^\s-]+)/m.exec(dockerfile)?.[1];
if (!from) {
  console.error("check-e2e-toolchain: no `FROM rust:<version>` in e2e/Dockerfile");
  process.exit(1);
}

if (from !== channel) {
  console.error(
    `check-e2e-toolchain: TOOLCHAIN DRIFT\n\n` +
      `  rust-toolchain.toml pins : ${channel}\n` +
      `  e2e/Dockerfile builds on : ${from}\n\n` +
      "  Every cargo call in the E2E container will re-provision the pinned\n" +
      "  toolchain at runtime — slow, and not crash-safe. Bump the FROM line to\n" +
      `  rust:${channel}-slim (and rebuild the image: docker build -t myne-e2e -f e2e/Dockerfile e2e).`,
  );
  process.exit(1);
}

// Matching the channel is not enough on its own: the base image carries only
// cargo/rustc/rust-std, so anything else the pin asks for is still fetched by
// the first cargo call unless the image bakes it in.
const missing = [];
const components = /^\s*components\s*=\s*\[([^\]]*)\]/m.exec(pin)?.[1] ?? "";
const targets = /^\s*targets\s*=\s*\[([^\]]*)\]/m.exec(pin)?.[1] ?? "";
for (const c of components.match(/"([^"]+)"/g) ?? []) {
  const name = c.replaceAll('"', "");
  if (!new RegExp(`rustup component add[^\\n]*\\b${name}\\b`).test(dockerfile)) missing.push(`component ${name}`);
}
for (const t of targets.match(/"([^"]+)"/g) ?? []) {
  const name = t.replaceAll('"', "");
  if (!new RegExp(`rustup target add[^\\n]*\\b${name}\\b`).test(dockerfile)) missing.push(`target ${name}`);
}

if (missing.length > 0) {
  console.error(
    `check-e2e-toolchain: the image does not bake what the pin requires\n\n` +
      missing.map((m) => `  - ${m}`).join("\n") +
      "\n\n  `rust:<version>-slim` ships cargo/rustc/rust-std and nothing else, so\n" +
      "  each of these is downloaded by the first cargo call in every container.\n" +
      "  Add it to the `rustup component add` / `rustup target add` line in\n" +
      "  e2e/Dockerfile.",
  );
  process.exit(1);
}

// ---- The RUNTIME package set, which lives in two places that never meet ----
//
// THE FAILURE THIS PREVENTS. `e2e/Dockerfile` is the local seat; CI does not use
// it at all. The `e2e` and `e2e-quarantine` steps in `.woodpecker.yml` start from
// a bare `rust:<version>-slim` and `apt-get install` their own list. So the two
// seats' runtime packages are two hand-maintained lists in two files, and a
// scenario that reaches for a binary present in only one of them is green on a
// developer machine and red in CI — with a `spawn ENOENT` that names the binary
// and nothing about why it is missing on one seat.
//
// Not hypothetical: `xdotool` was added for myne-md/myne#555 (the toplevel window
// cannot be driven any other way — WebKitWebDriver accepts `POST /window/rect`
// and silently ignores it, see `e2e/support/xwindow.ts`). Adding it to the
// Dockerfile alone would have shipped exactly that.
//
// Compared in ONE direction on purpose: every package the local image installs
// must also be installed by every CI E2E step. The reverse is deliberately not
// required — CI adds `mold`, a linker it wants for its own build times and the
// local image has no reason to carry. A both-ways comparison would fail on that
// and the honest fix would be to add packages nobody needs.
// **The CI corpus is three places now, and naming one of them was how this
// check went blind.** It used to read a single `.woodpecker.yml`; myne-md/myne#579
// split that into the `.woodpecker/` DIRECTORY and myne-md/myne#585 moved the
// build sysdeps into the prebuilt base image, so the file this opened stopped
// existing and the guard died on ENOENT rather than reporting anything. The
// three that carry an apt line today: every Woodpecker config (through the one
// module that knows where they live, imported rather than copied), the E2E
// lane script that now owns the seat's runtime set, and `ci/Dockerfile`, which
// bakes what the seat starts from — a package in the image IS installed on the
// seat, so leaving it out would demand a redundant apt entry.
//
// A path that is absent is a FAILURE rather than a smaller corpus: this check
// compares two package sets, and a set read from nothing is empty, which agrees
// with everything.
const CI_SOURCES = [
  ...woodpeckerConfigPaths(ROOT),
  join(ROOT, "scripts", "ci-e2e-lane.sh"),
  join(ROOT, "ci", "Dockerfile"),
];
const woodpecker = CI_SOURCES.map((f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    console.error(
      `check-e2e-toolchain: cannot read ${f}\n\n` +
        "  Every CI source this check compares against must be readable. A missing\n" +
        "  one silently shrinks the package set it derives, and a set derived from\n" +
        "  nothing agrees with every image. Fix the path rather than the check.",
    );
    process.exit(1);
  }
}).join("\n")
  // Fold shell/Dockerfile line continuations FIRST. The markers this check
  // greps for (`webkit2gtk-driver`, `libwebkit2gtk-4.1-dev`) sit on the
  // continuation line while `apt-get install` sits on the one before it, so a
  // per-line filter matches neither half and reports "the lane was
  // restructured" about a lane that is fine.
  .replace(/\\\n\s*/g, " ");

/**
 * The package names on an `apt-get install` line.
 *
 * Stops at the first `&&`, which is not tidiness: every one of these lines ends
 * `&& rm -rf /var/lib/apt/lists/*`, and reading past the operator makes `rm` a
 * package. It was reported as one before this stopped.
 */
function aptPackages(line) {
  const after = line.slice(line.indexOf("apt-get install") + "apt-get install".length);
  const untilChain = after.split("&&")[0] ?? "";
  return untilChain
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !w.startsWith("-") && !w.includes("/"))
    .filter((w) => /^[a-z0-9][a-z0-9.+-]*$/.test(w));
}

// Shell line continuations are UNFOLDED first. The Dockerfile writes its main
// apt line across six physical lines with trailing backslashes, and the first
// version of this check split on "\n" — so the only package it could see was
// `xdotool`, which happens to be the one-line install. It reported
// `1 runtime package(s)` and `ok`, having compared almost nothing: precisely the
// "reports ok on an input it could not read" failure this repo's guard rules are
// about, committed inside a guard written to prevent a sibling of it. The
// structural assertion below is what turned that from green into a failure.
const unfold = (text) => text.replace(/\\\r?\n\s*/g, " ");

const dockerAptLines = unfold(dockerfile)
  .split("\n")
  .filter((l) => l.includes("apt-get install"));
if (dockerAptLines.length === 0) {
  console.error(
    "check-e2e-toolchain: no `apt-get install` line in e2e/Dockerfile.\n\n" +
      "  This check compares the local image's runtime packages against the CI\n" +
      "  steps' own apt list. Finding none means the file moved or the install\n" +
      "  shape changed — it does NOT mean there is nothing to compare, so it\n" +
      "  fails rather than reporting ok on an input it could not read.",
  );
  process.exit(1);
}
const dockerPkgs = new Set(dockerAptLines.flatMap(aptPackages));

// STRUCTURAL NON-VACUITY, not a magic minimum. `webkit2gtk-driver` is the
// package that makes a seat an E2E seat — it is what the CI lines below are
// matched on, and the image cannot run a scenario without it. If parsing the
// Dockerfile did not produce it, the parse is wrong and every comparison after
// this point is against a set that does not describe the file.
if (!dockerPkgs.has("webkit2gtk-driver")) {
  console.error(
    "check-e2e-toolchain: could not read e2e/Dockerfile's package list\n\n" +
      `  Parsed ${dockerPkgs.size} package(s) and none of them is \`webkit2gtk-driver\`,\n` +
      "  which the image demonstrably installs. The apt line's shape changed (a\n" +
      "  different continuation style, a variable, a second RUN), so the set\n" +
      "  below is not the file's. Fix the parse; do not lower this check.",
  );
  process.exit(1);
}

// The CI steps that stand in for the local image. Matched by the runtime marker
// they all carry rather than by step name, since the step list has grown.
const ciAptLines = woodpecker
  .split("\n")
  .filter((l) => l.includes("apt-get install") && l.includes("webkit2gtk-driver"));
if (ciAptLines.length === 0) {
  console.error(
    "check-e2e-toolchain: no E2E `apt-get install` line in any CI source\n\n" +
      "  Looked for a line installing `webkit2gtk-driver`, which is what makes an\n" +
      "  apt line an E2E-seat one. Zero matches means the CI lane was restructured\n" +
      "  and this check is now blind — fix the marker rather than deleting the\n" +
      "  check.",
  );
  process.exit(1);
}

// WHAT IS COMPARED: the E2E RUNTIME additions, not the whole package set.
//
// The image carries two kinds of package and only one of them belongs on the CI
// E2E seat. The Dockerfile says so itself — "Tauri build sysdeps (same list as
// .woodpecker.yml's tauri-compile step) + the E2E runtime additions". CI's E2E
// steps consume a binary the `tauri-compile` step already produced, so they have
// no reason to carry `libgtk-3-dev` and friends, and demanding it would be this
// check inventing work.
//
// So the build half is SUBTRACTED, and derived from the tree rather than
// rostered here: whatever `tauri-compile` installs is by definition a build dep.
// A roster would be a third hand-maintained list, which is the failure mode this
// whole check exists for.
const compileAptLines = woodpecker
  .split("\n")
  .filter((l) => l.includes("apt-get install") && l.includes("libwebkit2gtk-4.1-dev"));
if (compileAptLines.length === 0) {
  console.error(
    "check-e2e-toolchain: no build-sysdeps `apt-get install` line in any CI source\n\n" +
      "  Looked for a line installing `libwebkit2gtk-4.1-dev`, which is what marks\n" +
      "  an apt line as the Tauri BUILD sysdeps. Without it this check cannot tell\n" +
      "  a build dep from an E2E runtime dep, and would demand every -dev package\n" +
      "  on the CI E2E seat. Fix the marker rather than deleting the check.",
  );
  process.exit(1);
}
const buildPkgs = new Set(compileAptLines.flatMap(aptPackages));
const runtimePkgs = [...dockerPkgs].filter((pkg) => !buildPkgs.has(pkg));

const seatDrift = [];
for (const line of ciAptLines) {
  const have = new Set(aptPackages(line));
  for (const pkg of runtimePkgs) {
    if (!have.has(pkg)) seatDrift.push(pkg);
  }
}

// The same structural non-vacuity, one layer down. After subtracting the build
// deps the set must still contain the WebDriver runtime, or the subtraction ate
// the thing this check is about and every seat would compare clean.
if (!runtimePkgs.includes("webkit2gtk-driver")) {
  console.error(
    "check-e2e-toolchain: the E2E runtime package set came out empty of the driver\n\n" +
      `  After subtracting the tauri-compile build sysdeps, ${runtimePkgs.length} package(s)\n` +
      "  remain and `webkit2gtk-driver` is not among them. That means the build-dep\n" +
      "  line now also installs the driver, so the subtraction removes exactly what\n" +
      "  this check should be comparing. Fix the split; do not lower this check.",
  );
  process.exit(1);
}

if (seatDrift.length > 0) {
  console.error(
    "check-e2e-toolchain: E2E SEAT DRIFT\n\n" +
      `  e2e/Dockerfile installs, and a CI E2E step does not:\n` +
      [...new Set(seatDrift)].map((m) => `    - ${m}`).join("\n") +
      "\n\n  CI does not build e2e/Dockerfile — the `e2e` and `e2e-quarantine`\n" +
      "  steps apt-install their own list on a bare rust image. A scenario using\n" +
      "  a binary present only locally passes here and fails there with a bare\n" +
      "  ENOENT. Add the package to BOTH apt lines in the CI sources.",
  );
  process.exit(1);
}

console.log(
  `check-e2e-toolchain: ok (rust ${channel}; image bakes ${[...(components.match(/"([^"]+)"/g) ?? []), ...(targets.match(/"([^"]+)"/g) ?? [])].length} pinned component(s)/target(s); ` +
    `${runtimePkgs.length} E2E runtime package(s) present on all ${ciAptLines.length} CI E2E seat(s))`,
);
