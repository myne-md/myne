#!/usr/bin/env node
// Every tool the CI pipeline EXECUTES is provisioned at a pinned, hash-verified
// version before it runs (myne-md/myne#758, security-audit lead NV02).
//
// # The failure this prevents
//
// Fourteen invocations across `.woodpecker/main.yml`, `.woodpecker/e2e.yml` and
// `scripts/ci-e2e-lane.sh` ran `/cache/bin/sccache` and `/cache/bin/cargo-nextest`
// straight off a host-provided mount that no line in this repository provisions,
// pins or checksums. Every push compiled through a compiler wrapper of unknown
// version, chosen by whatever `/srv/wp-cache` on the CI box happened to hold, and
// nothing would have noticed a substituted binary: `RUSTC_WRAPPER` is just a path
// and the pipeline never asks where the file came from. The contrast sat a few
// lines away in the same file, where `cargo-deny` downloads a pinned prebuilt
// release and verifies it with an inline `sha256sum -c`.
//
// `scripts/ci-pinned-tools.sh` closes it. This guard is what keeps it closed,
// because the three ways it can silently come undone are all invisible to every
// compiler and to a green pipeline:
//
//   1. A NEW `/cache/bin/<tool>` reference in a workflow or in the E2E lane script
//      for a tool the provisioner does not pin. That is the original defect, one
//      edit away.
//   2. A STEP that references a pinned tool but never runs the provisioner. The
//      script is per-step (`rust:*-slim` steps share no shell), so a step copied
//      from another and missing the first line executes whatever is on the mount,
//      which is exactly the state this issue closed.
//   3. A PIN whose `version`, `url`, tarball digest and binary digest drift apart.
//      The digests are the whole protection: a bump that edits the version and the
//      URL but leaves the old digest reds every step with a checksum mismatch, and
//      a bump that edits the digest to match an unverified download is caught by
//      nothing downstream. A pin that is well-formed but unused is reported too,
//      so a retired tool's entry cannot sit there implying coverage.
//
// Deliberately narrow in the same way as `check-playwright-image.mjs`: every
// failure names the file, the step and the tool, and an input it could not read is
// a failure rather than a pass.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readWoodpeckerConfigs } from "./lib/woodpecker-configs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PROVISIONER = "scripts/ci-pinned-tools.sh";
export const LANE_SCRIPT = "scripts/ci-e2e-lane.sh";

/** Where the provisioned tools live: a writable half of the cache volume. */
export const TOOLS_DIR = "/cache/tools/bin";

/**
 * The read-only mount the tools used to come from.
 *
 * It is refused by name rather than tolerated, and the refusal is the first
 * pipeline's finding: `/cache/bin` is mounted read-only, so a step can neither
 * provision there nor repair it, and anything executed from that path is
 * whatever the host put there. The guard would otherwise pass a step that
 * reached back for it, because the tool name is pinned either way.
 */
const READ_ONLY_MOUNT = /\/cache\/bin\//;

const HEX64 = /^[0-9a-f]{64}$/;
const CACHE_BIN = /\/cache\/tools\/bin\/([a-z][a-z0-9-]*)/g;

/**
 * The pins, read out of the provisioner itself rather than duplicated here.
 *
 * Duplicating them would make this guard a second place to update and let the two
 * disagree, which is the shape it exists to catch. The `case "$tool" in … esac` arms are
 * parsed on their literal lines, so that file stays the single source of truth.
 */
export function readPins(text) {
  const pins = new Map();
  const arm = /^ {4}([a-z][a-z0-9-]*)\)\n((?: {6}.*\n)+)/gm;
  for (const [, tool, body] of text.matchAll(arm)) {
    const field = (name) => {
      const m = body.match(new RegExp(`^ {6}${name}="([^"]*)"$`, "m"));
      return m ? m[1] : null;
    };
    pins.set(tool, {
      version: field("version"),
      url: field("url"),
      tarballSha: field("tarball_sha"),
      binSha: field("bin_sha"),
      member: field("member"),
    });
  }
  return pins;
}

/** Split a workflow file into `{ name, text }`, one entry per top-level step. */
export function splitSteps(text) {
  const steps = [];
  let current = null;
  let inSteps = false;
  for (const line of text.split("\n")) {
    if (/^steps:\s*$/.test(line)) {
      inSteps = true;
      continue;
    }
    if (!inSteps) continue;
    const decl = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (decl) {
      current = { name: decl[1], text: "" };
      steps.push(current);
      continue;
    }
    if (current) current.text += `${line}\n`;
    // A top-level key after `steps:` ends the section.
    if (/^[a-z][a-z0-9-]*:\s*$/.test(line)) inSteps = false;
  }
  return steps;
}

/**
 * Every failure, as strings. Pure over its inputs so `tests/scripts/` can inject
 * each defect with a fixture instead of editing the tree.
 *
 * `files` is `[{ rel, text, isLaneScript? }]`.
 */
export function audit({ provisionerText, files }) {
  const failures = [];
  const fail = (msg) => failures.push(msg);

  const pins = readPins(provisionerText);
  if (pins.size === 0) {
    fail(
      `${PROVISIONER} declares no pins. The parser looks for \`case "$tool" in\` arms of the shape ` +
        "`    <tool>)` followed by indented `version=…` lines; if that layout changed, update " +
        "readPins() rather than leaving this guard unable to see the pins it holds.",
    );
  }
  for (const [tool, pin] of pins) {
    for (const [field, value] of Object.entries(pin)) {
      if (!value) fail(`${PROVISIONER}: the \`${tool}\` pin has no \`${field}\`.`);
    }
    // The URL must name the version, either through the shell variable (the
    // strongest form: one edit moves both) or literally, so a bump cannot verify
    // one asset and install another.
    if (
      pin.version &&
      pin.url &&
      !pin.url.includes(pin.version) &&
      !pin.url.includes("${version}")
    ) {
      fail(
        `${PROVISIONER}: the \`${tool}\` url names neither the version (${pin.version}) nor ` +
          "`${version}`. A version bump has to move both.",
      );
    }
    if (pin.tarballSha && !HEX64.test(pin.tarballSha)) {
      fail(`${PROVISIONER}: the \`${tool}\` tarball_sha is not a lowercase sha256.`);
    }
    if (pin.binSha && !HEX64.test(pin.binSha)) {
      fail(`${PROVISIONER}: the \`${tool}\` bin_sha is not a lowercase sha256.`);
    }
  }

  const used = new Set();
  let sawReference = false;

  for (const { rel, text, isLaneScript } of files) {
    const steps = isLaneScript
      ? [{ name: rel, text }]
      : splitSteps(text).filter((s) => /\/cache\/(?:tools\/)?bin\//.test(s.text));

    for (const step of steps) {
      if (READ_ONLY_MOUNT.test(step.text)) {
        sawReference = true;
        fail(
          `${rel}: step \`${step.name}\` executes a binary from \`/cache/bin/\`, which is a ` +
            "READ-ONLY mount on the CI host (measured: `install: cannot create regular file " +
            "'/cache/bin/…': Read-only file system`). Nothing there can be provisioned, so nothing " +
            `there can be verified. Use \`${TOOLS_DIR}/<tool>\`, which ${PROVISIONER} provisions ` +
            "(myne-md/myne#758, NV02).",
        );
        continue;
      }
      const referenced = new Set([...step.text.matchAll(CACHE_BIN)].map((m) => m[1]));
      if (referenced.size === 0) continue;
      sawReference = true;
      for (const tool of referenced) {
        used.add(tool);
        if (!pins.has(tool)) {
          fail(
            `${rel}: step \`${step.name}\` executes \`${TOOLS_DIR}/${tool}\`, which ` +
              `${PROVISIONER} does not pin. Nothing in this repository would decide or verify what ` +
              "that binary is. That is the defect myne-md/myne#758 closed.",
          );
        }
      }
      // A step must provision before it executes. The lane script carries the call
      // itself (guarded on the mount, which is the only place the binaries come
      // from), so `isLaneScript` files are judged by the same rule.
      if (!step.text.includes("ci-pinned-tools.sh")) {
        fail(
          `${rel}: step \`${step.name}\` runs ${[...referenced].join(", ")} from /cache/bin but ` +
            `never calls ${PROVISIONER}. The provisioner is per-step because the steps do not ` +
            "share a shell, so a step copied without that first line executes an unverified " +
            "binary (myne-md/myne#758, NV02).",
        );
      }
    }
  }

  if (!sawReference) {
    fail(
      "No `/cache/bin/` reference found in any workflow file or the E2E lane script. If the " +
        "compiler wrapper moved, update CACHE_BIN here: a guard that scans for a path nothing " +
        "uses reports ok while checking nothing.",
    );
  }

  for (const tool of pins.keys()) {
    if (!used.has(tool)) {
      fail(
        `${PROVISIONER} pins \`${tool}\` but no workflow file or the E2E lane script references ` +
          `\`/cache/bin/${tool}\`. Remove the pin, or the entry reads as coverage for a binary ` +
          "nothing runs.",
      );
    }
  }

  return { failures, pins, used };
}

function main() {
  if (!existsSync(join(ROOT, PROVISIONER))) {
    process.stderr.write(
      `check-pinned-ci-tools: ${PROVISIONER} is missing. Every /cache/bin/<tool> reference in CI ` +
        "executes an unpinned binary without it (myne-md/myne#758).\n",
    );
    process.exit(1);
  }

  const files = [
    ...readWoodpeckerConfigs(ROOT).map((f) => ({ ...f, isLaneScript: false })),
    {
      rel: LANE_SCRIPT,
      text: readFileSync(join(ROOT, LANE_SCRIPT), "utf8"),
      isLaneScript: true,
    },
  ];
  const { failures, pins, used } = audit({
    provisionerText: readFileSync(join(ROOT, PROVISIONER), "utf8"),
    files,
  });

  for (const tool of used) {
    const pin = pins.get(tool);
    if (pin?.binSha) {
      process.stdout.write(`  ${tool} ${pin.version} (${pin.binSha.slice(0, 12)}…)\n`);
    }
  }
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`check-pinned-ci-tools: ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(`check-pinned-ci-tools: ok, ${pins.size} pinned CI tool(s)\n`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
