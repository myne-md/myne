#!/usr/bin/env node
// `ci/Dockerfile` must bake the versions the rest of the repo pins, and the
// workflows must reference the digest that was actually published from it.
//
// WHAT THIS PREVENTS. The image exists to stop five CI steps apt-installing the
// same eleven Tauri sysdeps on every push, and it does that by moving a
// toolchain out of the steps and into a prebuilt artefact. That trade has one
// failure mode, and it is silent in both directions.
//
// Silent forward: somebody bumps `rust-toolchain.toml`, `.nvmrc` or the root
// `packageManager` field, the image stays on the old version, and every step
// then runs on a toolchain the repo does not pin. For Rust that is not even
// loud: rustup honours `rust-toolchain.toml` at runtime, so it silently
// RE-PROVISIONS the pinned toolchain inside whichever step makes the first
// cargo call, which is slow and, as `check-e2e-toolchain.mjs` records, not
// crash-safe. One run raced that provisioning into
// `failed to install component ... detected conflict` and reported 255 failures
// in 266 s, 245 of them one infrastructure error wearing a test's name.
//
// Silent backward: somebody edits `ci/Dockerfile` and does not republish, so
// the digest in the workflows describes an image the file no longer produces.
// The file then reads as the source of truth for something nobody is running.
//
// Same shape as `check-e2e-toolchain.mjs` (which holds `e2e/Dockerfile`'s Rust
// version to `rust-toolchain.toml`) and `check-playwright-image.mjs` (which
// holds a CI image tag to `pnpm-lock.yaml`). Like both, it compares in BOTH
// directions and fails BY NAME when an input cannot be found, rather than
// reporting ok on something it never read.
//
// DELIBERATELY NOT CHECKED: the Go version. Its only counterpart is
// `myne-server`'s `go.mod`, which lives in a companion repo that is absent from
// CI and from a fresh clone. A check that skips on a missing input is a check
// that reads as a pass, which is the failure this whole family exists to avoid,
// so the Go pin is left to review and said so out loud here rather than
// half-guarded.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readWoodpeckerConfigs } from "./lib/woodpecker-configs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCKERFILE = join(ROOT, "ci", "Dockerfile");
const RECORD = join(ROOT, "ci", "image.json");

/** The image repository the workflows are allowed to reference. */
export const IMAGE_REPO = "ghcr.io/myne-md/myne-ci";

/** `FROM rust:<version>-slim` from the Dockerfile. */
export function dockerfileRust(text) {
  const m = text.match(/^FROM\s+rust:([\d.]+)-slim\s*$/m);
  return m ? m[1] : null;
}

/** An `ARG <NAME>=<value>` from the Dockerfile. */
export function dockerfileArg(text, name) {
  const m = text.match(new RegExp(`^ARG\\s+${name}=([\\w.\\-]+)\\s*$`, "m"));
  return m ? m[1] : null;
}

/** `channel = "<version>"` from rust-toolchain.toml. */
export function toolchainChannel(text) {
  const m = text.match(/^\s*channel\s*=\s*"([\d.]+)"/m);
  return m ? m[1] : null;
}

/** The version half of `"packageManager": "pnpm@<version>"`. */
export function packageManagerVersion(text) {
  const m = text.match(/"packageManager"\s*:\s*"pnpm@([\w.\-]+)"/);
  return m ? m[1] : null;
}

/** Every `ghcr.io/myne-md/myne-ci@sha256:<digest>` reference in the CI config. */
export function referencedDigests(yml) {
  const re = new RegExp(`${IMAGE_REPO.replace(/[./]/g, "\\$&")}@(sha256:[0-9a-f]{64})`, "g");
  return [...yml.matchAll(re)].map((m) => m[1]);
}

/** A reference to the image by TAG rather than by digest, which is the mutable
 *  form this guard exists to keep out: a republished tag changes what a gate ran
 *  on without changing a single tracked byte. */
export function taggedReferences(yml) {
  const re = new RegExp(`${IMAGE_REPO.replace(/[./]/g, "\\$&")}:[\\w.\\-]+`, "g");
  return [...yml.matchAll(re)].map((m) => m[0]);
}

/** A `myne-ci@...` reference whose digest is not a well-formed `sha256:<64 hex>`.
 *
 *  Separate from `referencedDigests` because of how the first version of this
 *  guard read: a placeholder left in a workflow matched neither the digest
 *  pattern nor the tag pattern, so the scan found nothing and the guard reported
 *  "no workflow references the image", which points the reader at a missing
 *  reference when what is actually there is a broken one. A guard that names the
 *  wrong problem costs more than one that names none. */
export function malformedReferences(yml) {
  const re = new RegExp(`${IMAGE_REPO.replace(/[./]/g, "\\$&")}@(\\S+)`, "g");
  return [...yml.matchAll(re)]
    .map((m) => m[1])
    .filter((d) => !/^sha256:[0-9a-f]{64}$/.test(d));
}

function fail(message) {
  console.error(`ci image: FAIL — ${message}`);
  process.exit(1);
}

function main() {
  if (!existsSync(DOCKERFILE)) {
    fail(
      `no ci/Dockerfile at ${DOCKERFILE}. Either the base image was removed (then ` +
        "drop this guard, ci/image.json and every workflow reference in the same " +
        "change) or it moved and this guard is now reading nothing.",
    );
  }
  if (!existsSync(RECORD)) {
    fail(
      `no ci/image.json at ${RECORD}. That file is what records the published ` +
        "digest; without it nothing states which build of ci/Dockerfile the " +
        "workflows are actually running.",
    );
  }

  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const record = JSON.parse(readFileSync(RECORD, "utf8"));
  const yml = readWoodpeckerConfigs()
    .map(({ text }) => text)
    .join("\n");

  // ── 1. Pinned versions, Dockerfile against their sources ──────────────────
  const checks = [
    {
      what: "rust",
      baked: dockerfileRust(dockerfile),
      bakedFrom: "ci/Dockerfile `FROM rust:<version>-slim`",
      pinned: toolchainChannel(readFileSync(join(ROOT, "rust-toolchain.toml"), "utf8")),
      pinnedFrom: "rust-toolchain.toml `channel`",
    },
    {
      what: "node",
      baked: dockerfileArg(dockerfile, "NODE_VERSION"),
      bakedFrom: "ci/Dockerfile `ARG NODE_VERSION`",
      pinned: readFileSync(join(ROOT, ".nvmrc"), "utf8").trim(),
      pinnedFrom: ".nvmrc",
    },
    {
      what: "pnpm",
      baked: dockerfileArg(dockerfile, "PNPM_VERSION"),
      bakedFrom: "ci/Dockerfile `ARG PNPM_VERSION`",
      pinned: packageManagerVersion(readFileSync(join(ROOT, "package.json"), "utf8")),
      pinnedFrom: "package.json `packageManager`",
    },
  ];

  for (const c of checks) {
    if (c.baked === null) fail(`could not read ${c.what} version from ${c.bakedFrom}.`);
    if (!c.pinned) fail(`could not read ${c.what} version from ${c.pinnedFrom}.`);
    if (c.baked !== c.pinned) {
      fail(
        `${c.what} ${c.baked} in ${c.bakedFrom} against ${c.pinned} in ${c.pinnedFrom}.\n` +
          "  The image is what every sysdeps step runs on. Rebuild and republish it\n" +
          "  (operations/runbooks/ci-base-image.md), then update ci/image.json and the\n" +
          "  digest in the workflow files.",
      );
    }
  }

  // ── 2. Digest, workflows against the record, both directions ──────────────
  if (!/^sha256:[0-9a-f]{64}$/.test(record.digest ?? "")) {
    fail("ci/image.json carries no `digest` of the form sha256:<64 hex>.");
  }

  const tagged = taggedReferences(yml);
  if (tagged.length > 0) {
    fail(
      `${[...new Set(tagged)].join(", ")} referenced by TAG rather than by digest.\n` +
        "  A tag is mutable: republishing it changes what a gate ran on without\n" +
        "  changing a tracked byte. Use " +
        `${IMAGE_REPO}@${record.digest}.`,
    );
  }

  const malformed = malformedReferences(yml);
  if (malformed.length > 0) {
    fail(
      `${[...new Set(malformed)].join(", ")} is not a well-formed sha256 digest.\n` +
        `  Expected ${IMAGE_REPO}@${record.digest}. A placeholder left here would\n` +
        "  otherwise read to this guard as no reference at all.",
    );
  }

  const referenced = referencedDigests(yml);
  if (referenced.length === 0) {
    fail(
      `ci/image.json records ${record.digest} but no workflow references ` +
        `${IMAGE_REPO}@<digest>. A recorded image nothing runs is a record of ` +
        "nothing, so this fails rather than passing on an empty scan.",
    );
  }

  const stale = referenced.filter((d) => d !== record.digest);
  if (stale.length > 0) {
    fail(
      `workflow digest(s) ${[...new Set(stale)].join(", ")} against ` +
        `${record.digest} in ci/image.json.`,
    );
  }

  console.log(
    `ci image: ok (rust ${checks[0].baked}, node ${checks[1].baked}, pnpm ${checks[2].baked}; ` +
      `${referenced.length} reference(s) at ${record.digest.slice(0, 19)}...)`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("check-ci-image.mjs")) {
  main();
}
