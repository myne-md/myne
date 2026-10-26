#!/usr/bin/env node
// Refuse to run the browser lane against a `web/wasm/pkg` built from other
// sources than the ones on disk.
//
// The failure this prevents, and it is measured rather than imagined:
// `pnpm web:build` compiles the TypeScript and BUNDLES `web/wasm/pkg`, which is
// a build artefact it does not produce. Rebuilding the wasm is
// `scripts/build-wasm.sh`, and nothing in the lane called it. So on 2026-10-22
// the web E2E lane spent a session measuring a wasm binary built five days
// earlier, and the "two vault containers are not discovered" bug it reported did
// not exist: the binary under test predated the walk entirely. The lane was
// green about last week's product.
//
// The tell is not visible anywhere a run reports it. `web:build` succeeds, the
// bundle hash changes (the JS changed), and the driver starts. Only the exported
// surface is old.
//
// ## Why a content digest and not mtimes
//
// The first version compared mtimes, and `tests/scripts/ignoredTests.test.ts`
// rewrites one `core/` file and restores it in `afterEach`: same bytes, new
// mtime. That made a freshly built wasm read as stale after any unit run, which
// is a check that cries wolf until someone disables it. The digest is over
// relative path + content, so a touch changes nothing and a real edit always
// does.
//
// ## The watch list is manifests as well as sources
//
// "The crate itself, the crates it links" is not enough: a FEATURE FLAG that
// gates compiled code lives in a `Cargo.toml`, and a dependency can add or
// remove a whole linked crate without one `.rs` byte moving. `core/Cargo.toml`,
// `protocol/Cargo.toml` and `format/Cargo.toml` were missing from this list
// while its own header claimed to cover "the manifests that decide what those
// are", so a `remote-ai` or `local-inference` toggle could change the built
// binary and the lane would still call the old artefact fresh (myne-md/myne#911
// review).
//
//   node scripts/check-web-wasm-freshness.mjs            # say it, exit 1 if stale
//   node scripts/check-web-wasm-freshness.mjs --quiet     # exit code only
//   node scripts/check-web-wasm-freshness.mjs --write     # record (build-wasm.sh)
//   node scripts/check-web-wasm-freshness.mjs --self-test # inject every defect
//
// The runners (`e2e-web-local.sh`, `e2e-web-one.sh`) call this BEFORE they start
// a driver, so a stale artefact stops the lane instead of silently defining what
// the lane proves.
//
// ## Why `--self-test` exists
//
// Verifying a guard means breaking it, and a session in which somebody once
// broke it by hand is not evidence anybody can re-run. The mode injects the five
// cases this guard claims, in a temporary tree it creates and deletes: a matching
// digest passes; a changed `.rs` byte is named STALE; a `core/Cargo.toml` edit is
// named STALE (the entry this change added); a missing digest fails with its own
// message rather than the stale one; and a touch that changes no byte still
// passes.

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";

const WRITE = process.argv.includes("--write");
const QUIET = process.argv.includes("--quiet");
const SELF_TEST = process.argv.includes("--self-test");

const WASM = join("web", "wasm", "pkg", "myne_web_wasm_bg.wasm");
const DIGEST = join("web", "wasm", "pkg", ".source-digest");

/** Every tree a change to which can change the wasm: the crate itself, the
 *  crates it links, and the manifests that decide what those are. A workspace
 *  crate outside this list cannot reach the browser binary; a new one that can
 *  belongs here. */
export const WATCHED = [
  join("web", "wasm", "src"),
  // The crate's own manifest: a feature or dependency change there changes the
  // built binary and is invisible to every other file in this list.
  join("web", "wasm", "Cargo.toml"),
  join("core", "src"),
  join("core", "build.rs"),
  // The linked crates' manifests, for the same reason as the crate's own: a
  // feature flag selects code inside them, and a dependency edit can change the
  // closure without touching a `.rs` file.
  join("core", "Cargo.toml"),
  join("protocol", "src"),
  join("protocol", "Cargo.toml"),
  join("format", "src"),
  join("format", "Cargo.toml"),
  // `theme-validator` is a normal (non-optional) dependency of `myne-core`, so it
  // is inside the wasm closure even though no `.rs` here names it: a tightened or
  // relaxed custom-theme allowlist changes the built binary and would otherwise
  // leave the digest unmoved while the lane tested the previous allowlist
  // (myne-md/myne#911 review). `cargo tree -p myne-web-wasm -e normal` is the
  // authority on this list, not intuition.
  join("theme-validator", "src"),
  join("theme-validator", "Cargo.toml"),
  join("Cargo.toml"),
  join("Cargo.lock"),
];

function collect(path, out) {
  if (!existsSync(path)) return out;
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path).sort()) collect(join(path, entry), out);
  } else if (path.endsWith(".rs") || path.endsWith(".toml") || path.endsWith(".lock")) {
    out.push(path);
  }
  return out;
}

/**
 * The digest over `roots`, read relative to `root`.
 *
 * `root` is a parameter rather than `process.cwd()` so `--self-test` can measure
 * a throwaway tree. The hash input is the path RELATIVE to the root, which is
 * what the shipped invocation produces: a rename with identical bytes is a
 * different source tree, and a content-only digest would miss it.
 */
export function sourceDigest({ root = process.cwd(), roots = WATCHED } = {}) {
  const files = [];
  for (const r of roots) collect(join(root, r), files);
  const h = createHash("sha256");
  for (const file of files) {
    h.update(relative(root, file));
    h.update("\0");
    h.update(readFileSync(file));
    h.update("\0");
  }
  return { digest: h.digest("hex"), count: files.length };
}

/**
 * Whether the recorded digest still describes the sources, and the sentence a
 * reader gets either way.
 *
 * Pure, so every branch is reachable from `--self-test` without building a
 * wasm. `wasmExists` is checked first because a missing artefact needs a
 * different fix (build it) from a stale one (rebuild it), and the two messages
 * are the whole value of this guard: "stale" is the next sentence a person
 * reads after a red lane.
 */
export function verdict({ digest, count, recorded, wasmExists, digestExists }) {
  if (!wasmExists) {
    return {
      ok: false,
      message:
        `no built wasm at ${WASM}.\n` +
        "  Build it before running the browser lane:  ./scripts/build-wasm.sh",
    };
  }
  if (!digestExists) {
    return {
      ok: false,
      message:
        `cannot tell whether ${WASM} matches the sources: no ${DIGEST}.\n` +
        "  Rebuild it so the record is written:  ./scripts/build-wasm.sh",
    };
  }
  if (recorded !== digest) {
    return {
      ok: false,
      message:
        `the wasm bundle is STALE: the sources now hash ${digest.slice(0, 12)} over ${count} ` +
        `file(s), and the built binary was recorded as ${recorded.slice(0, 12)}.\n` +
        "  `pnpm web:build` does NOT rebuild the wasm; it bundles whatever is in\n" +
        "  web/wasm/pkg. Running the browser lane now would test an older binary.\n" +
        "  Rebuild it:  ./scripts/build-wasm.sh && pnpm web:build",
    };
  }
  return {
    ok: true,
    message: `ok (${count} source file(s), ${digest.slice(0, 12)})`,
  };
}

function fail(message) {
  console.error(`check-web-wasm-freshness: ${message}`);
  process.exit(1);
}

/**
 * Inject each defect this guard claims. Every case is a property of the DIGEST
 * or of the decision, so the fixture is a tiny tree rather than the repository:
 * measuring the real tree cannot tell "the manifest is watched" from "some other
 * file changed", which is exactly the failure this change fixes.
 */
function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "myne-wasm-freshness-"));
  const write = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  const caseFailed = (name, detail) => {
    console.error(`  FAIL ${name}: ${detail}`);
    return 1;
  };
  let bad = 0;
  try {
    write(join("web", "wasm", "src", "lib.rs"), "pub fn boot() {}\n");
    write(join("web", "wasm", "Cargo.toml"), "[package]\nname = \"myne-web-wasm\"\n");
    write(join("core", "src", "lib.rs"), "pub fn core() {}\n");
    write(join("core", "build.rs"), "fn main() {}\n");
    write(join("core", "Cargo.toml"), "[package]\nname = \"myne-core\"\n");
    write(join("protocol", "src", "lib.rs"), "pub fn protocol() {}\n");
    write(join("protocol", "Cargo.toml"), "[package]\nname = \"protocol\"\n");
    write(join("format", "src", "lib.rs"), "pub fn format() {}\n");
    write(join("format", "Cargo.toml"), "[package]\nname = \"myne-format\"\n");
    write("Cargo.toml", "[workspace]\n");
    write("Cargo.lock", "# lock\n");
    mkdirSync(join(root, WASM, ".."), { recursive: true });
    writeFileSync(join(root, WASM), "wasm bytes");
    writeFileSync(join(root, DIGEST), "recorded\n");

    // 1. A digest that matches passes.
    const first = sourceDigest({ root });
    const fresh = verdict({
      ...first,
      recorded: first.digest,
      wasmExists: true,
      digestExists: true,
    });
    if (!fresh.ok) bad += caseFailed("matching digest passes", fresh.message);

    // 2. A watched `.rs` byte change is named STALE, with the stale message.
    write(join("core", "src", "lib.rs"), "pub fn core() { /* edited */ }\n");
    const edited = sourceDigest({ root });
    const changed = verdict({
      ...edited,
      recorded: first.digest,
      wasmExists: true,
      digestExists: true,
    });
    if (changed.ok || !changed.message.includes("STALE")) {
      bad += caseFailed("a changed .rs byte is STALE", changed.message);
    }

    // 3. A `core/Cargo.toml` edit is STALE. This is the entry the change added:
    // with the manifest outside WATCHED the digest would not move at all.
    const beforeManifest = edited.digest;
    write(join("core", "Cargo.toml"), "[package]\nname = \"myne-core\"\ndefault = [\"remote-ai\"]\n");
    const manifest = sourceDigest({ root });
    const manifestVerdict = verdict({
      ...manifest,
      recorded: beforeManifest,
      wasmExists: true,
      digestExists: true,
    });
    if (manifestVerdict.ok || !manifestVerdict.message.includes("STALE")) {
      bad += caseFailed("a core/Cargo.toml edit is STALE", manifestVerdict.message);
    }
    if (manifest.digest === beforeManifest) {
      bad += caseFailed("a core/Cargo.toml edit MOVES the digest", "digest unchanged");
    }

    // 4. A missing digest fails with its OWN message, not the stale one.
    const missing = verdict({
      ...manifest,
      recorded: "",
      wasmExists: true,
      digestExists: false,
    });
    if (missing.ok || missing.message.includes("STALE") || !missing.message.includes(DIGEST)) {
      bad += caseFailed("a missing digest has its own message", missing.message);
    }

    // 5. A touch with no byte change still passes. This is the mtime trap the
    // first version fell into: same bytes, new timestamp.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(root, "core", "Cargo.toml"), future, future);
    utimesSync(join(root, "core", "src", "lib.rs"), future, future);
    const touched = sourceDigest({ root });
    const touchVerdict = verdict({
      ...touched,
      recorded: manifest.digest,
      wasmExists: true,
      digestExists: true,
    });
    if (!touchVerdict.ok) bad += caseFailed("a touch with no byte change passes", touchVerdict.message);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (bad > 0) fail(`${bad} of 6 self-test assertions did not behave as claimed`);
  console.log("check-web-wasm-freshness: self-test ok, 5 injected cases (6 assertions)");
  process.exit(0);
}

function report(message) {
  if (!QUIET) console.error(`check-web-wasm-freshness: ${message}`);
}

function main() {
  const { digest, count } = sourceDigest();

  if (WRITE) {
    if (!existsSync(WASM)) {
      report(`--write needs a built wasm at ${WASM}; run scripts/build-wasm.sh normally`);
      process.exit(1);
    }
    writeFileSync(DIGEST, `${digest}\n`, "utf8");
    if (!QUIET) {
      console.log(`check-web-wasm-freshness: recorded ${digest.slice(0, 12)} over ${count} file(s)`);
    }
    process.exit(0);
  }

  const result = verdict({
    digest,
    count,
    recorded: existsSync(DIGEST) ? readFileSync(DIGEST, "utf8").trim() : "",
    wasmExists: existsSync(WASM),
    digestExists: existsSync(DIGEST),
  });
  if (!result.ok) {
    report(result.message);
    process.exit(1);
  }
  if (!QUIET) console.log(`check-web-wasm-freshness: ${result.message}`);
}

// Only when RUN, so importing this module (a test, a one-off comparison) does
// not measure the tree and exit the process.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (SELF_TEST) selfTest();
  main();
}
