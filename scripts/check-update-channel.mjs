#!/usr/bin/env node
// One channel, one endpoint, one name for the variable that picks it.
//
// # The failure this prevents
//
// A build's update channel is decided at compile time by `MYNE_UPDATE_CHANNEL`,
// and FIVE places used to name some part of that decision: the Rust updater's
// endpoint, the Vite define the About panel renders, the Vitest define the same
// panel renders under test, the log header's channel field, and
// `plugins.updater.endpoints` in `tauri.conf.json`. Two of them were worse than
// a duplicate:
//
//   * The config's endpoint did nothing at all. The plugin is built with
//     `UpdaterBuilder::endpoints`, which REPLACES the config list rather than
//     merging with it, so a reader of `tauri.conf.json` concluded that a beta
//     build fetched the stable manifest and the only way to learn otherwise was
//     to read `tauri-plugin-updater`'s own source.
//   * The Rust endpoint's file name is written twice, here and in the emitter
//     that produces the document (`scripts/emit-update-manifest.mjs`). Move one
//     and the client fetches a file nobody publishes, which on a released build
//     is an update channel that quietly stops working with every other gate
//     green.
//
// The one resolution now lives in `src-tauri/src/update/mod.rs` (a channel
// table, resolved at compile time), every other reader derives from it, and this
// guard is what holds the derivations together.
//
// # What it does NOT cover, stated so it is not mistaken for more
//
// It does not fetch anything, so it cannot tell you that the manifests are
// published, current, or ordered. That is
// `scripts/check-published-manifests.mjs`, which needs the network and runs by
// hand around a release. This one is offline and static, so it runs in
// pre-commit and CI beside the other guards.
//
// It also does not check the public key's VALUE, only that one is present, and
// it does not verify that `requireSignedVersion` is on.
//
// Zero dependencies, hand-runnable:
//   node scripts/check-update-channel.mjs
//   node scripts/check-update-channel.mjs --root /path/to/tree   (used by tests)

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestFilename } from "./emit-update-manifest.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The one origin every manifest lives under.
 *
 * Repeated in Rust (`MANIFEST_ORIGIN`) rather than injected, and compared by
 * this guard: an origin is a privacy claim (the update check is the one egress
 * the user does not name a provider for), so a second origin appearing is a new
 * party, not a refactor.
 */
const ORIGIN = "https://downloads.myne.md/releases/";

/**
 * The channels `decisions/clients/0651` ships.
 *
 * Names only, deliberately: the file name each one publishes comes from
 * `manifestFilename`, so this guard holds no second copy of `latest.json`.
 */
const REQUIRED_CHANNELS = ["stable", "beta"];

const FILES = {
  config: "src-tauri/tauri.conf.json",
  channel: "src-tauri/src/update/mod.rs",
  vite: "vite.config.ts",
  vitest: "vitest.config.ts",
  about: "src/components/settings/AboutPanel.tsx",
};

/** `pub const MANIFEST_ORIGIN: &str = "https://…";` */
const ORIGIN_RE = /MANIFEST_ORIGIN\s*:\s*&str\s*=\s*"([^"]+)"/;
/** `Channel { name: "stable", manifest: "latest.json" },` */
const CHANNEL_ROW_RE =
  /Channel\s*\{\s*name:\s*"([a-z][a-z0-9-]*)"\s*,\s*manifest:\s*"([^"]+)"\s*,?\s*\}/g;
/** `None => 0,` */
const RUST_DEFAULT_INDEX_RE = /None\s*=>\s*(\d+)\s*,/;
/** `option_env!("MYNE_UPDATE_CHANNEL")` */
const RUST_ENV_RE = /option_env!\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/;
/**
 * `__UPDATE_CHANNEL__: JSON.stringify(process.env.MYNE_UPDATE_CHANNEL ?? "stable")`
 *
 * One expression, both facts: which variable the define reads, and what it
 * means when the variable is unset. Matched as a whole so the guard cannot pick
 * up an unrelated `process.env.<X>` elsewhere in the build config, which the
 * first version of it did.
 */
const VITE_DEFINE_RE =
  /__UPDATE_CHANNEL__:\s*JSON\.stringify\(\s*process\.env\.([A-Z][A-Z0-9_]*)\s*(?:\?\?\s*"([a-z][a-z0-9-]*)"\s*)?\)/;
/**
 * `__UPDATE_CHANNEL__: JSON.stringify("stable")` in `vitest.config.ts`.
 *
 * The test tree defines the channel as a literal, because Vitest does not load
 * `vite.config.ts`'s env read. It is a FOURTH writing of a channel name, so it
 * is compared against the build's own fallback: a test that renders the About
 * panel should see the channel a build made without the variable would.
 */
const VITEST_DEFINE_RE = /__UPDATE_CHANNEL__:\s*JSON\.stringify\(\s*"([a-z][a-z0-9-]*)"\s*\)/;
/**
 * The message an unrecognized value must fail the build with.
 *
 * Matched by its text rather than by the arm's shape, so the resolution can be
 * rewritten (a `match` guard, a table lookup, a helper) as long as the build
 * still refuses a channel this repository does not ship.
 */
const UNKNOWN_FAILS_BUILD_RE = /panic!\(\s*"MYNE_UPDATE_CHANNEL must be/;

/** Every match of a global regexp, as an array. */
function matches(re, text) {
  return [...text.matchAll(re)];
}

/**
 * Audit the files' contents.
 *
 * Pure, so a test drives every rule with an injected defect rather than editing
 * the tree. `input` carries the file texts already read, plus the path each one
 * was read from so a failure can name it.
 */
export function audit(input) {
  const failures = [];
  const {
    config,
    configPath,
    channel,
    channelPath,
    vite,
    vitePath,
    vitest,
    vitestPath,
    about,
    aboutPath,
  } = input;

  // --- R1: the config carries no endpoint --------------------------------
  // The endpoint is compile-time, and a list here is overridden rather than
  // merged, so it can only mislead.
  let parsed = null;
  try {
    parsed = JSON.parse(config);
  } catch {
    failures.push(`${configPath}: not valid JSON, so its updater config could not be checked.`);
  }
  if (parsed !== null) {
    const updater = parsed?.plugins?.updater;
    if (updater === undefined) {
      failures.push(
        `${configPath}: no \`plugins.updater\` block. The plugin needs its \`pubkey\` there, and ` +
          `this guard needs the block to know the endpoint list is still absent.`,
      );
    } else {
      if ("endpoints" in updater) {
        failures.push(
          `${configPath}: \`plugins.updater.endpoints\` is back. The endpoint is decided in ` +
            `${channelPath} (\`Channel::endpoint\`) and nowhere else: ` +
            `\`UpdaterBuilder::endpoints\` REPLACES this list rather than merging with it, so a ` +
            `value here is silently ignored and a reader believes the opposite of what ships. ` +
            `Delete it.`,
        );
      }
      if (typeof updater.pubkey !== "string" || updater.pubkey.length === 0) {
        failures.push(
          `${configPath}: \`plugins.updater.pubkey\` is missing or empty, so no offered update ` +
            `could ever be verified.`,
        );
      }
    }
  }

  // --- R2: one origin -----------------------------------------------------
  const origin = ORIGIN_RE.exec(channel)?.[1];
  if (origin === undefined) {
    failures.push(
      `${channelPath}: no \`MANIFEST_ORIGIN\` constant found. If it was renamed, teach this ` +
        `guard the new shape rather than deleting it, or the origin stops being checked at all.`,
    );
  } else if (origin !== ORIGIN) {
    failures.push(
      `${channelPath}: the manifest origin is ${origin}, not ${ORIGIN}. An update check is the ` +
        `one egress the user does not name a provider for, so a different origin is a different ` +
        `party rather than a refactor.`,
    );
  }

  // --- R3: the table and the emitter name the same files ------------------
  const rows = matches(CHANNEL_ROW_RE, channel).map((m) => ({ name: m[1], manifest: m[2] }));
  if (rows.length === 0) {
    failures.push(
      `${channelPath}: no \`Channel { name: "…", manifest: "…" }\` row found. If the table was ` +
        `reshaped, teach this guard the new shape rather than deleting it, or the channel list ` +
        `and the emitter go back to drifting silently.`,
    );
  }
  for (const row of rows) {
    let expected;
    try {
      expected = manifestFilename(row.name);
    } catch {
      failures.push(
        `${channelPath} and scripts/emit-update-manifest.mjs disagree: a channel is named ` +
          `\`${row.name}\`, which the emitter does not know. Add it to \`manifestFilename\` and to ` +
          `the publish procedure in the runbook in the same change, or the client fetches a file ` +
          `nobody writes.`,
      );
      continue;
    }
    if (row.manifest !== expected) {
      failures.push(
        `${channelPath}: the \`${row.name}\` channel reads ${row.manifest} but the emitter writes ` +
          `${expected}. One of the two moved.`,
      );
    }
  }
  for (const name of REQUIRED_CHANNELS) {
    if (!rows.some((row) => row.name === name)) {
      failures.push(
        `${channelPath}: the \`${name}\` channel is gone. \`decisions/clients/0651\` ships two ` +
          `channels; removing one is a decision, not a rename.`,
      );
    }
  }
  const extra = rows.filter((row) => !REQUIRED_CHANNELS.includes(row.name));
  for (const row of extra) {
    failures.push(
      `${channelPath}: \`${row.name}\` joined the channel set. Every reader has to learn it in ` +
        `the same change: \`manifestFilename\`, the Vite define, the About label, and the publish ` +
        `procedure in the runbook. Teach this guard too, so it keeps checking.`,
    );
  }

  // --- R4: one variable name, in both languages ---------------------------
  const rustEnv = RUST_ENV_RE.exec(channel)?.[1];
  const viteDefine = VITE_DEFINE_RE.exec(vite);
  const viteEnv = viteDefine?.[1];
  if (rustEnv === undefined) {
    failures.push(
      `${channelPath}: no \`option_env!("…")\` found, so the channel cannot be checked against ` +
        `the Vite define.`,
    );
  }
  if (viteDefine === null) {
    failures.push(
      `${vitePath}: the \`__UPDATE_CHANNEL__\` define is gone or no longer reads as ` +
        `\`JSON.stringify(process.env.<NAME> ?? "<default>")\`. Teach this guard the new shape ` +
        `rather than deleting it: the About label and the fetched endpoint are separate ` +
        `mechanisms, and this define is the label half.`,
    );
  }
  if (rustEnv !== undefined && viteEnv !== undefined && rustEnv !== viteEnv) {
    failures.push(
      `the channel variable is read under two names: ${channelPath} reads \`${rustEnv}\`, ` +
        `${vitePath} reads \`${viteEnv}\`. One of the two then takes whatever the build ` +
        `environment happens to leave behind, and the label can disagree with the endpoint.`,
    );
  }

  // --- R5: the same default, in both languages ----------------------------
  const defaultIndex = RUST_DEFAULT_INDEX_RE.exec(channel)?.[1];
  const rustDefault = defaultIndex === undefined ? undefined : rows[Number(defaultIndex)];
  if (rustDefault === undefined) {
    failures.push(
      `${channelPath}: could not read which row an unset variable selects (expected a ` +
        `\`None => <row index>\` arm). If the resolution was reshaped, teach this guard, or the ` +
        `unset-variable case stops being compared against the Vite define.`,
    );
  }
  if (viteDefine !== null && viteDefine?.[2] === undefined) {
    failures.push(
      `${vitePath}: the \`__UPDATE_CHANNEL__\` define has no fallback, so a build made with the ` +
        `variable unset renders an undefined label instead of the default channel.`,
    );
  } else if (rustDefault !== undefined && viteDefine?.[2] !== undefined) {
    if (rustDefault.name !== viteDefine[2]) {
      failures.push(
        `the unset-variable default disagrees: Rust selects \`${rustDefault.name}\`, the Vite ` +
          `define falls back to \`${viteDefine[2]}\`. A build made without the variable set then ` +
          `shows one channel in About and fetches the other one's manifest.`,
      );
    }
  }

  // --- R6: an unrecognized value still fails the build --------------------
  if (!UNKNOWN_FAILS_BUILD_RE.test(channel)) {
    failures.push(
      `${channelPath}: an unrecognized \`MYNE_UPDATE_CHANNEL\` value no longer fails the build. ` +
        `A fallback arm means a typo produces a build believed to be one channel and actually ` +
        `another, with nothing anywhere saying so. That failure is why the arm exists.`,
    );
  }

  // --- R7: the test define names the same channel ------------------------
  const vitestLiteral = VITEST_DEFINE_RE.exec(vitest)?.[1];
  const viteFallback = viteDefine?.[2];
  if (vitestLiteral === undefined) {
    failures.push(
      `${vitestPath}: no \`__UPDATE_CHANNEL__: JSON.stringify("…")\` found. It exists ` +
        `because Vitest does not load ${vitePath}'s env read, and it is a fourth writing of a ` +
        `channel name, so this guard compares it. Teach the guard if its shape changed.`,
    );
  } else if (viteFallback !== undefined && vitestLiteral !== viteFallback) {
    failures.push(
      `${vitestPath} and ${vitePath} disagree about the default channel: the test define ` +
        `renders \`${vitestLiteral}\`, a build made without the variable is \`${viteFallback}\`. ` +
        `A unit test of the About panel then asserts a label no shipped build shows.`,
    );
  }

  // --- R8: the UI names every non-default channel -------------------------
  for (const row of rows) {
    if (rustDefault !== undefined && row.name === rustDefault.name) continue;
    if (!about.includes(`"${row.name}"`)) {
      failures.push(
        `${aboutPath}: does not mention the \`${row.name}\` channel, so a ${row.name} build ` +
          `renders the default channel's label. If the panel was restructured, teach this guard ` +
          `the new shape.`,
      );
    }
  }

  return failures;
}

/** Read the files under `root` and audit them. */
export function scan(root) {
  const input = {};
  const missing = [];
  for (const [key, rel] of Object.entries(FILES)) {
    try {
      input[key] = readFileSync(join(root, rel), "utf8");
      input[`${key}Path`] = rel;
    } catch {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    // Silence would be the wrong answer: a guard that cannot find its input has
    // stopped checking, and that is exactly when it prints ok.
    return [`not found: ${missing.join(", ")}. This guard is looking at the wrong tree.`];
  }
  return audit(input);
}

function main(argv) {
  let root = REPO_ROOT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      root = resolve(argv[i + 1] ?? "");
      i += 1;
    }
  }

  const failures = scan(root);
  if (failures.length > 0) {
    console.error("update channel: FAILED");
    for (const message of failures) console.error(`  - ${message}`);
    process.exit(1);
  }
  console.log(
    `update channel: ok (one endpoint in ${FILES.channel}, one variable name, ` +
      `no endpoint in ${FILES.config})`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
