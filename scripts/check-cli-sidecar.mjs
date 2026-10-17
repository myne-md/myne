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
//   6. `cli/src/framing.rs`'s LENGTH_PREFIX_BYTES + MAX_FRAME_BODY  ==
//      cli_bridge/framing.rs's (the wire's byte-length prefix and body cap)
//   7. `cli/src/status.rs`'s door-byte decode  ==  cli_bridge/status.rs's;
//      and the desktop's own `byte_for` encode must agree with its `parse`
//      decode (the CLI has no encoder — it only reads the marker)
//
// Number 5 exists because the E2E suite reads the marker and the socket inode
// straight off disk to decide when the door has opened, which makes it a THIRD
// independent holder of those two basenames — and the one whose drift is most
// misleading: `waitForDoor` would simply time out, reading as "the socket never
// opened" rather than "the test is looking in the wrong place".
//
// Number 6 is the same shape one layer down: the framing module is a second
// by-design copy (neither crate depends on the other), and a `MAX_FRAME_BODY`
// that disagrees means one side rejects a frame the other accepts, with the
// refusal surfacing as a truncated read rather than a clear size error.
//
// Number 7 is the marker byte set: `D`/`L`/`O` are matched by hand in both
// trees, so a renamed or re-letttered state decodes to `None` on one side and
// reads as "app not running" while the app is running.
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

/**
 * Pull a `const NAME: usize = <integer arithmetic>;` and evaluate it.
 *
 * Numeric, not textual: `16 * 1024 * 1024` and `0x1000000` are the same cap
 * written two ways, and comparing the raw expression would call that drift.
 * Only digits, `*`, `+`, `-`, parentheses and `_` separators are read; anything
 * else fails loudly rather than silently evaluating to something wrong.
 */
function rustUsizeConst(source, file, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*:\\s*usize\\s*=\\s*([0-9_\\s*+()-]+);`));
  if (!match) {
    fail(`${file}: could not find \`const ${name}: usize = …\` — did it get renamed?`);
    return null;
  }
  const expr = match[1].replace(/_/g, "").trim();
  if (!/^[0-9*+()\s-]+$/.test(expr)) {
    fail(`${file}: \`${name}\` expression "${match[1]}" is not plain integer arithmetic.`);
    return null;
  }
  const value = Function(`"use strict"; return (${expr});`)();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${file}: \`${name}\` did not evaluate to a finite number.`);
    return null;
  }
  return value;
}

/** `DoorState variant -> byte` from the `b"X" => (Some(DoorState::V))` decode arms. */
function rustDecodeByteMap(source, file) {
  const map = new Map();
  const re = /b"([^"]{1})"\s*=>\s*(?:Some\(\s*)?DoorState::(\w+)\s*\)?/g;
  let m;
  while ((m = re.exec(source)) !== null) map.set(m[2], m[1]);
  if (map.size === 0) fail(`${file}: no \`b"X" => …DoorState::Variant\` arm found — renamed?`);
  return map;
}

/** `DoorState variant -> byte` from the `DoorState::V -> b"X"` encode arms. */
function rustEncodeByteMap(source, file) {
  const map = new Map();
  const re = /DoorState::(\w+)\s*=>\s*b"([^"]{1})"/g;
  let m;
  while ((m = re.exec(source)) !== null) map.set(m[1], m[2]);
  if (map.size === 0) fail(`${file}: no \`DoorState::Variant => b"X"\` arm found — renamed?`);
  return map;
}

/** Compare two `variant -> byte` maps both ways, naming each side's file. */
function compareByteMaps(label, a, aFile, b, bFile) {
  for (const [variant, byte] of a) {
    if (!b.has(variant)) {
      fail(`${label} drift: \`${variant}\` is mapped in ${aFile} but absent from ${bFile}.`);
    } else if (b.get(variant) !== byte) {
      fail(
        `${label} drift: \`${variant}\` is "${byte}" in ${aFile} but "${b.get(variant)}" in ${bFile}.`,
      );
    }
  }
  for (const variant of b.keys()) {
    if (!a.has(variant)) {
      fail(`${label} drift: \`${variant}\` is mapped in ${bFile} but absent from ${aFile}.`);
    }
  }
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

// ── 6. Framing constants (length prefix + body cap) ────────────────────────
const cliFraming = read("cli/src/framing.rs");
const desktopFraming = read("src-tauri/src/cli_bridge/framing.rs");
const CLI_FRAMING = "cli/src/framing.rs";
const DESKTOP_FRAMING = "src-tauri/src/cli_bridge/framing.rs";
for (const name of ["LENGTH_PREFIX_BYTES", "MAX_FRAME_BODY"]) {
  const cliValue = rustUsizeConst(cliFraming, CLI_FRAMING, name);
  const desktopValue = rustUsizeConst(desktopFraming, DESKTOP_FRAMING, name);
  if (cliValue !== null && desktopValue !== null && cliValue !== desktopValue) {
    fail(
      `${name} drift: ${CLI_FRAMING} has ${cliValue}, ${DESKTOP_FRAMING} has ${desktopValue}. ` +
        `One side would reject a frame the other accepts, surfacing as a truncated ` +
        `read rather than a clear size error.`,
    );
  }
}

// ── 7. Status-marker bytes (D / L / O) ─────────────────────────────────────
// The CLI only DECODES the marker; the desktop both writes (`byte_for`) and, as
// the tested reference decoder, reads (`parse`). All three must agree, so the
// desktop's own encode/decode pair is compared too — a `byte_for` that disagrees
// with `parse` is a writer and reader that cannot meet.
const cliStatus = read("cli/src/status.rs");
const desktopStatus = read("src-tauri/src/cli_bridge/status.rs");
const CLI_STATUS = "cli/src/status.rs";
const DESKTOP_STATUS = "src-tauri/src/cli_bridge/status.rs";
compareByteMaps(
  "status-marker decode",
  rustDecodeByteMap(cliStatus, CLI_STATUS),
  CLI_STATUS,
  rustDecodeByteMap(desktopStatus, DESKTOP_STATUS),
  DESKTOP_STATUS,
);
compareByteMaps(
  "status-marker encode vs decode",
  rustEncodeByteMap(desktopStatus, `${DESKTOP_STATUS} (byte_for)`),
  `${DESKTOP_STATUS} byte_for`,
  rustDecodeByteMap(desktopStatus, `${DESKTOP_STATUS} (parse)`),
  `${DESKTOP_STATUS} parse`,
);

if (failures.length > 0) {
  console.error("cli sidecar contract: FAILED");
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(
  `cli sidecar contract: ok (identifier "${conf.identifier}", externalBin "${EXTERNAL_BIN_ENTRY}")`,
);
