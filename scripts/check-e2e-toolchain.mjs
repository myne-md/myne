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
//   node scripts/check-e2e-toolchain.mjs

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

console.log(
  `check-e2e-toolchain: ok (rust ${channel}; image bakes ${[...(components.match(/"([^"]+)"/g) ?? []), ...(targets.match(/"([^"]+)"/g) ?? [])].length} pinned component(s)/target(s))`,
);
