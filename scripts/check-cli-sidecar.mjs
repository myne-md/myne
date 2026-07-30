#!/usr/bin/env node
// The `myne` sidecar's cross-file contract: bundle identifier + socket/status
// basenames + the `externalBin` entry (cli-thin-client task 11; MYND-490).
//
// The failure this prevents: the CLI is a SEPARATE binary that talks to the
// desktop over a path both sides compute independently — there is no shared Rust
// type, deliberately (`cli/Cargo.toml` has no dependency on `myne-desktop`, so a
// wire/path contract is duplicated by design). Five literals therefore have to
// agree across four files, and nothing in either compiler can see the other side
// (the fourth file is not even typechecked — see 5 below):
//
//   1. `cli/src/paths.rs`'s BUNDLE_IDENTIFIER  ==  tauri.conf.json's `identifier`
//   2. `cli/src/paths.rs`'s SOCKET_BASENAME    ==  cli_bridge/socket.rs's SOCKET_BASENAME
//   3. `cli/src/paths.rs`'s STATUS_BASENAME    ==  cli_bridge/status.rs's STATUS_BASENAME
//   4. tauri.conf.json's `bundle.externalBin`  contains the staged sidecar path
//   5. the E2E suite's own copies of 2 + 3 (`e2e/cli-thin-client.e2e.ts`)
//
// Number 5 exists because the E2E suite reads the marker and the socket inode
// straight off disk to decide when the door has opened, which makes it a THIRD
// independent holder of those two basenames — and the one whose drift is most
// misleading: `waitForDoor` would simply time out, reading as "the socket never
// opened" rather than "the test is looking in the wrong place".
//
// Drift in 1-3 does not fail any build, any clippy run, or any unit test on either
// side: both crates compile perfectly and the shipped `myne` simply looks for a
// socket nobody binds, so every command reports "app not running" while the app is
// running. Drift in 4 silently un-ships the CLI from the bundle. Both are invisible
// until someone runs the real binary against a real install — which is exactly the
// thing CI cannot do.
//
// Zero dependencies, hand-runnable: node scripts/check-cli-sidecar.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

/** The `externalBin` entry the staging script (`build-cli-sidecar.mjs`) feeds. */
const EXTERNAL_BIN_ENTRY = "binaries/myne";

const failures = [];
const fail = (message) => failures.push(message);

/** Pull a `const NAME: &str = "value";` out of a Rust source file. */
function rustStrConst(source, file, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*:\\s*&str\\s*=\\s*"([^"]*)"`));
  if (!match) {
    fail(`${file}: could not find \`const ${name}: &str = "…"\` — did it get renamed?`);
    return null;
  }
  return match[1];
}

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const cliPaths = read("cli/src/paths.rs");
const socketRs = read("src-tauri/src/cli_bridge/socket.rs");
const statusRs = read("src-tauri/src/cli_bridge/status.rs");

// ── 1. Bundle identifier ────────────────────────────────────────────────────
// Tauri's own `app_data_dir()` is `dirs::data_dir().join(identifier)`, and the CLI
// mirrors that resolution independently — so the identifier is a wire contract.
const cliIdentifier = rustStrConst(cliPaths, "cli/src/paths.rs", "BUNDLE_IDENTIFIER");
if (cliIdentifier !== null && cliIdentifier !== conf.identifier) {
  fail(
    `bundle identifier drift: tauri.conf.json has "${conf.identifier}", ` +
      `cli/src/paths.rs::BUNDLE_IDENTIFIER has "${cliIdentifier}". ` +
      `The CLI would look for the command socket under the wrong app-data dir.`,
  );
}

// ── 2 + 3. Socket + status basenames ───────────────────────────────────────
for (const [name, desktopSource, desktopFile] of [
  ["SOCKET_BASENAME", socketRs, "src-tauri/src/cli_bridge/socket.rs"],
  ["STATUS_BASENAME", statusRs, "src-tauri/src/cli_bridge/status.rs"],
]) {
  const cliValue = rustStrConst(cliPaths, "cli/src/paths.rs", name);
  const desktopValue = rustStrConst(desktopSource, desktopFile, name);
  if (cliValue !== null && desktopValue !== null && cliValue !== desktopValue) {
    fail(
      `${name} drift: ${desktopFile} has "${desktopValue}", ` +
        `cli/src/paths.rs has "${cliValue}".`,
    );
  }
}

// ── 4. The sidecar is actually in the bundle ───────────────────────────────
const externalBin = conf.bundle?.externalBin ?? [];
if (!externalBin.includes(EXTERNAL_BIN_ENTRY)) {
  fail(
    `tauri.conf.json: bundle.externalBin must contain "${EXTERNAL_BIN_ENTRY}" ` +
      `or the desktop bundle ships without the \`myne\` CLI ` +
      `(scripts/build-cli-sidecar.mjs stages it there).`,
  );
}

// ── 5. The E2E suite's copies of the same two basenames ────────────────────
const e2eSpecRel = "e2e/cli-thin-client.e2e.ts";
const e2eSpec = read(e2eSpecRel);
for (const name of ["SOCKET_BASENAME", "STATUS_BASENAME"]) {
  const match = e2eSpec.match(new RegExp(`const\\s+${name}\\s*=\\s*"([^"]*)"`));
  if (!match) {
    fail(`${e2eSpecRel}: could not find \`const ${name} = "…"\` — did it get renamed?`);
    continue;
  }
  const cliValue = rustStrConst(cliPaths, "cli/src/paths.rs", name);
  if (cliValue !== null && match[1] !== cliValue) {
    fail(
      `${name} drift: cli/src/paths.rs has "${cliValue}", ` +
        `${e2eSpecRel} has "${match[1]}". The E2E door-state waits would time out ` +
        `against a running, working door.`,
    );
  }
}

if (failures.length > 0) {
  console.error("cli sidecar contract: FAILED");
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(
  `cli sidecar contract: ok (identifier "${conf.identifier}", externalBin "${EXTERNAL_BIN_ENTRY}")`,
);
