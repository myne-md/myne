#!/usr/bin/env node
// The CI Playwright image tag must name the same version `pnpm-lock.yaml`
// resolves for `@playwright/test`.
//
// **The failure this prevents is total and reads like something else.** The
// `mcr.microsoft.com/playwright:vX.Y.Z-noble` image bakes browser binaries at
// `/ms-playwright/<name>-<revision>/`, and the revision a Playwright release
// looks for is compiled into that release. A tag one minor version behind the
// lockfile is therefore not "slightly stale": the installed Playwright asks for
// a revision the image does not carry, and every test dies inside
// `browserType.launch` before reaching its first assertion.
//
// It shipped exactly that way. `mobile/package.json` asked for `^1.61.1`, the
// lockfile drifted to `1.62.1`, the image tag stayed at `v1.61.1`, and all 179
// `mobile-flow-logic` tests across 44 spec files failed with
// `Executable doesn't exist at /ms-playwright/chromium_headless_shell-1234/...`
// on develop and on every branch cut from it. Nothing else in the tree compares
// the two numbers: `pnpm install --frozen-lockfile` is happy, the image pulls,
// the step runs, and the lane is uniformly red for a reason that looks like a
// broken test suite rather than a missing binary.
//
// Same shape and same rationale as `check-e2e-toolchain.mjs`, which holds
// `e2e/Dockerfile`'s Rust version to `rust-toolchain.toml`: two halves of one
// pinned toolchain, kept in step by hand, with the drift invisible to every
// compiler.
//
// Deliberately narrow: it compares versions and fails BY NAME when either side
// cannot be found, rather than reporting ok on an input it could not read. A
// guard that answers "fine" when its own regex missed is the failure mode this
// repo keeps rediscovering.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readWoodpeckerConfigs } from "./lib/woodpecker-configs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `mcr.microsoft.com/playwright:v<version>-<variant>` tag in CI config. */
export function imageTags(woodpeckerYml) {
  return [...woodpeckerYml.matchAll(/mcr\.microsoft\.com\/playwright:v([\d.]+)-\w+/g)].map(
    (m) => m[1],
  );
}

/** The version `pnpm-lock.yaml` resolves for `@playwright/test`.
 *
 *  Read from the `packages:` section's resolution key rather than from any
 *  `package.json` specifier, because the specifier is what LIED: a caret range
 *  is not a version, and the caret is precisely how the two halves drifted. */
export function lockedVersion(lockYaml) {
  const m = lockYaml.match(/^\s+'@playwright\/test@([\d.]+)':/m);
  return m ? m[1] : null;
}

function main() {
  // EVERY workflow file. The config is a directory since myne-md/myne#579, and
  // the tag could be named in either half; the roster fails by name when it
  // cannot find the config, rather than scanning nothing and reporting ok.
  const yml = readWoodpeckerConfigs()
    .map(({ text }) => text)
    .join("\n");
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");

  const locked = lockedVersion(lock);
  if (locked === null) {
    console.error(
      "playwright image: FAIL — no `@playwright/test@<version>` entry found in " +
        "pnpm-lock.yaml. Either the dependency is gone (then drop the image tag " +
        "and this guard together) or the lockfile format moved and this guard is " +
        "now reading nothing.",
    );
    process.exit(1);
  }

  const tags = imageTags(yml);
  if (tags.length === 0) {
    console.error(
      "playwright image: FAIL — no `mcr.microsoft.com/playwright:v<version>-*` " +
        "image found in any .woodpecker/*.yml, but pnpm-lock.yaml still resolves " +
        `@playwright/test@${locked}. A renamed image would make this guard pass ` +
        "silently forever, so it fails instead.",
    );
    process.exit(1);
  }

  const wrong = tags.filter((t) => t !== locked);
  if (wrong.length > 0) {
    console.error(
      `playwright image: FAIL — image tag(s) ${[...new Set(wrong)].join(", ")} ` +
        `against @playwright/test@${locked} in pnpm-lock.yaml.\n` +
        "  The image bakes browsers for its own version, so a mismatch is not a\n" +
        "  slightly-old toolchain: every test fails in browserType.launch with\n" +
        "  `Executable doesn't exist at /ms-playwright/...`, before its first\n" +
        "  assertion. Move the tag to match the lockfile, or pin the dependency.",
    );
    process.exit(1);
  }

  console.log(
    `playwright image: ok (${tags.length} image tag(s) at v${locked}, matching pnpm-lock.yaml)`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("check-playwright-image.mjs")) {
  main();
}
