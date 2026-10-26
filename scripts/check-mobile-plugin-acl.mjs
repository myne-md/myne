#!/usr/bin/env node
// Every mobile capability grant resolves to a permission that actually exists
// (myne-md/myne#517).
//
// The failure this prevents, observed by injection rather than assumed. Delete
// `mobile/src-tauri/permissions/<plugin>/default.toml` and `cargo build` stays
// GREEN. The `InlinedPlugin` declaration in `build.rs` still auto-generates an
// `allow-<command>` / `deny-<command>` pair, so the namespace exists; what is
// gone is `default_permission`. And `capabilities/default.json` asking for
// `<plugin>:default` does not then error:
//
//   // tauri-utils-2.9.2/src/acl/resolved.rs:352-357, get_permissions()
//   if permission_name == "default" {
//     manifest.default_permission.as_ref()
//       .map(|default| get_permission_set_permissions(...))
//       .unwrap_or_else(|| Ok(Default::default()))    // <- EMPTY, no error
//
// The neighbouring `Error::UnknownPermission` arm is never reached on this path.
// So the capability resolves to an empty permission set, every command in that
// plugin is refused at runtime, and nothing anywhere says why: no build error,
// no lint, no test. The whole feature is simply inert. That is the safe
// direction to fail in, which is exactly why nobody notices.
//
// This is a DIFFERENT property from `check-mobile-export-backup.mjs`, which is
// why it is a different file, and this is the copy of that argument to keep
// current. That guard is about confidentiality: plaintext must not reach a
// platform backup. This one is about availability: a grant must resolve to
// something. Mixing them is what took one file to 898 lines while covering a
// single plugin.
//
// Scope: the mobile client only. Desktop has the same lockstep shape and is not
// covered here; generalising is a separate change with its own denominator, and
// saying so is cheaper than leaving the omission to read as coverage.
//
// Zero dependencies, hand-runnable: node scripts/check-mobile-plugin-acl.mjs
// Testable: `analyse(io)` takes its whole world as an argument, so
// `tests/scripts/mobilePluginAcl.test.ts` injects each failure class and asserts
// the guard names it. A guard that has never failed is a guard nobody has tested
// (root `CLAUDE.md`).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const BUILD_RS = "mobile/src-tauri/build.rs";
export const CAPABILITIES = "mobile/src-tauri/capabilities/default.json";
export const PERMISSIONS_ROOT = "mobile/src-tauri/permissions";

/**
 * Grants whose permissions do NOT live in this repository, with the reason.
 *
 * A named list rather than a "skip what we cannot find" rule, because those two
 * behave identically until the day somebody deletes a directory: one fails, the
 * other reports ok. Checked BOTH ways, so a name here that turns out to have an
 * in-repo permission directory fails as stale.
 */
export const EXTERNAL_GRANTS = {
  "core:event": "Tauri core, permissions ship inside the framework",
  "core:window": "Tauri core, permissions ship inside the framework",
  opener: "@tauri-apps/plugin-opener, permissions ship inside the plugin crate",
  "deep-link": "@tauri-apps/plugin-deep-link, permissions ship inside the plugin crate",
  "qr-scan": "in-repo Tauri plugin CRATE (mobile/src-tauri/tauri-plugin-qr-scan), not an InlinedPlugin",
  reminders: "in-repo Tauri plugin CRATE (mobile/src-tauri/tauri-plugin-reminders), not an InlinedPlugin",
  "sensitive-clipboard":
    "in-repo Tauri plugin CRATE (mobile/src-tauri/tauri-plugin-sensitive-clipboard), not an InlinedPlugin",
};

/**
 * `InlinedPlugin`s deliberately declared and deliberately NOT granted, with the
 * reason. Declaring one creates its ACL namespace; granting it is a separate
 * decision, so an ungranted namespace is legitimate and an ACCIDENTALLY
 * ungranted one is a feature that silently does nothing. Naming them is what
 * tells those two apart. Compared both ways.
 */
export const UNGRANTED_PLUGINS = {
  "local-inference":
    "the namespace is declared unconditionally so a feature-off build leaves no dangling grant; the runtime capability is added only when the `local-inference` feature registers the plugin (build.rs says so at its declaration)",
};

/**
 * Strip `//` line comments from Rust, anchored to the start of a line.
 *
 * Anchored is enough HERE, unlike in `check-mobile-export-backup.mjs`, and the
 * difference is worth stating because the two guards read the same language: the
 * pattern below needs the quoted plugin name and `InlinedPlugin::new()` adjacent
 * across whitespace, so a TRAILING comment cannot sit between them and the
 * line-start form is the only one that can fool it. That other guard reads enum
 * variants one per line, where a trailing comment is exactly the hole.
 */
export function stripRustLineComments(source) {
  return source.replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Strip `#` line comments. Anchored, because `#` appears mid-line in prose. */
export function stripTomlComments(toml) {
  return toml.replace(/^[ \t]*#.*$/gm, "");
}

/**
 * TOML top-level tables as `{ header, body }`, in file order.
 *
 * Per table rather than one lazy regex over the file: an unbounded match
 * crosses `[[permission]]` boundaries whenever a block lacks the key being
 * looked for, and credits it with the next block's.
 */
export function tomlTables(toml) {
  const tables = [];
  const header = /^(\[\[?[^\]\n]+\]\]?)[ \t]*$/gm;
  let match;
  let current = null;
  let start = 0;
  while ((match = header.exec(toml)) !== null) {
    if (current !== null) tables.push({ header: current, body: toml.slice(start, match.index) });
    current = match[1];
    start = match.index + match[0].length;
  }
  if (current !== null) tables.push({ header: current, body: toml.slice(start) });
  return tables;
}

/** The default world: the real repository on disk. */
export function diskIo(root = repoRoot) {
  return {
    exists: (rel) => existsSync(join(root, rel)),
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    listPermissionDirs: () => {
      const abs = join(root, PERMISSIONS_ROOT);
      if (!existsSync(abs)) return [];
      return readdirSync(abs, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    },
  };
}

/** Run every rule against `io`. */
export function analyse(io) {
  const failures = [];
  const fail = (message) => failures.push(message);

  // ── The three rosters ──────────────────────────────────────────────────
  let declared = new Map();
  if (!io.exists(BUILD_RS)) {
    fail(`${BUILD_RS}: missing, so this guard cannot know which plugins exist.`);
  } else {
    // Comment-stripped. A commented-out declaration does NOT always put the
    // `//` between the quoted name and `tauri_build::InlinedPlugin::new()`,
    // which is the shape the pattern below would survive: a SINGLE commented
    // line carrying both tokens puts the `//` at the start, before either of
    // them, and the pattern reads straight through it. Driven through
    // `analyse(io)` against the real `build.rs`, one such line raised the parsed
    // plugin count from 28 to 29 and produced a failure naming a plugin that
    // does not exist.
    const build = stripRustLineComments(io.read(BUILD_RS));
    for (const m of build.matchAll(
      /"([a-z0-9-]+)",\s*tauri_build::InlinedPlugin::new\(\)\s*(?:\.commands\(&\[)?([^\]]*)\]?/g,
    )) {
      declared.set(m[1], [...m[2].matchAll(/"([a-z0-9_]+)"/g)].map((c) => c[1]));
    }
    if (declared.size === 0) {
      fail(
        `${BUILD_RS}: no \`InlinedPlugin\` declarations parsed, so every rule below compared ` +
          `nothing. A guard that passes because it read nothing is the failure this file is for.`,
      );
    }
  }

  const dirs = io.listPermissionDirs();
  if (dirs.length === 0) {
    fail(`${PERMISSIONS_ROOT}: no permission directories found, this guard read nothing.`);
  }

  let granted = [];
  if (!io.exists(CAPABILITIES)) {
    fail(`${CAPABILITIES}: missing, so no grant can be resolved.`);
  } else {
    let parsed;
    try {
      parsed = JSON.parse(io.read(CAPABILITIES));
    } catch (e) {
      fail(`${CAPABILITIES}: is not valid JSON (${e.message}).`);
    }
    if (parsed) {
      if (!Array.isArray(parsed.permissions)) {
        fail(`${CAPABILITIES}: has no \`permissions\` array.`);
      } else {
        granted = parsed.permissions.filter((p) => p.endsWith(":default")).map((p) => p.slice(0, -":default".length));
      }
    }
  }

  // ── 1. Every `<plugin>:default` grant resolves to a real permission set ──
  // The discovery this guard exists for. An in-repo plugin whose file is gone,
  // or whose `[default]` table is gone, or whose list is empty, resolves to an
  // empty set with no build error.
  for (const plugin of granted) {
    if (plugin in EXTERNAL_GRANTS) continue;
    const file = `${PERMISSIONS_ROOT}/${plugin}/default.toml`;
    if (!io.exists(file)) {
      fail(
        `${CAPABILITIES}: grants \`"${plugin}:default"\` and ${file} does not exist. tauri-utils ` +
          `resolves that to an EMPTY permission set with no build error, so every ` +
          `\`plugin:${plugin}|…\` invoke is refused at runtime and nothing reports it. If the ` +
          `permissions live outside this repo, add \`${plugin}\` to EXTERNAL_GRANTS with the reason.`,
      );
      continue;
    }
    const tables = tomlTables(stripTomlComments(io.read(file)));
    const defaultTable = tables.find((t) => t.header === "[default]");
    if (!defaultTable) {
      fail(
        `${file}: no \`[default]\` table, so \`${plugin}:default\` resolves to an EMPTY ` +
          `permission set with no build error and every command in this plugin is refused.`,
      );
      continue;
    }
    const list = defaultTable.body.match(/permissions\s*=\s*\[([^\]]*)\]/);
    if (!list) {
      fail(`${file}: the \`[default]\` table carries no \`permissions = [...]\` list.`);
      continue;
    }
    const ids = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (ids.length === 0) {
      fail(`${file}: the \`[default]\` permission list is empty, which grants nothing.`);
      continue;
    }

    // Per-block, so an answer belongs to the block it came from.
    const defined = new Set();
    const denies = new Map();
    const commandsNothing = new Set();
    for (const { header, body } of tables) {
      if (header !== "[[permission]]") continue;
      const id = body.match(/identifier\s*=\s*"([^"]+)"/);
      if (!id) continue;
      defined.add(id[1]);
      const deny = body.match(/commands\.deny\s*=\s*\[([^\]]*)\]/);
      if (deny) denies.set(id[1], [...deny[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
      const allow = body.match(/commands\.allow\s*=\s*\[([^\]]*)\]/);
      const names = (m) => (m ? [...m[1].matchAll(/"([^"]+)"/g)].length : 0);
      if (names(allow) === 0 && names(deny) === 0) commandsNothing.add(id[1]);
    }
    for (const id of ids) {
      // Tauri auto-generates `allow-<command>` / `deny-<command>` from the
      // `InlinedPlugin` command list, so those need no `[[permission]]` block.
      if (!defined.has(id) && !/^(allow|deny)-[a-z0-9-]+$/.test(id)) {
        fail(
          `${file}: the \`[default]\` set names \`${id}\`, which no \`[[permission]]\` block in ` +
            `this file defines and which is not an auto-generated \`allow-\` / \`deny-\` name.`,
        );
      }
      // A granted permission that names no command at all authorizes nothing,
      // which is the same inert outcome one level down. It is the shape a
      // commented-out `commands.allow` leaves behind: the `identifier` line
      // survives, so the permission still exists and is still granted, and the
      // plugin is refused at runtime anyway. Measured against every directory
      // before this check was added: zero legitimate cases.
      if (commandsNothing.has(id)) {
        fail(
          `${file}: the \`[default]\` set includes \`${id}\`, which names no command in either ` +
            `\`commands.allow\` or \`commands.deny\`, so it authorizes nothing. A commented-out ` +
            `\`commands.allow\` leaves exactly this shape.`,
        );
      }
      // DENY WINS in Tauri's resolver, so granting one makes the command
      // unreachable while every file here and every build stays green.
      const denied = denies.get(id);
      if (denied && denied.length > 0) {
        fail(
          `${file}: the \`[default]\` set includes \`${id}\`, which DENIES ${denied.join(", ")}. ` +
            `Tauri resolves deny over allow, so those commands are refused at runtime. Tauri ` +
            `auto-generates a \`deny-<command>\` permission for every command, so this is a ` +
            `paste away.`,
        );
      }
    }

    // ── 1b. WHICH command, not merely SOME command ────────────────────────
    // The rule above asks whether a granted permission names any command at
    // all. This asks whether the ones `build.rs` DECLARES are among them, which
    // is the question a typo answers wrongly: `commands.allow = ["export_pathh"]`
    // satisfies every check above and refuses `plugin:export-dir|export_path` at
    // runtime.
    //
    // ONE direction only, deliberately. A permission may allow a command
    // `build.rs` does not list, because naming a command there is OPTIONAL
    // (`src-tauri/CLAUDE.md` "Capability ACL"). Running the reverse direction
    // produces 49 failures across TWO directories, `prefs` (47) and
    // `vault-unlock` (2). So a declared command must be allowed, and an allowed
    // command need not be declared.
    // Measured against every directory before this check landed: zero
    // pre-existing gaps in the direction that IS checked.
    const allowed = new Set();
    for (const { header, body } of tables) {
      if (header !== "[[permission]]") continue;
      const id = body.match(/identifier\s*=\s*"([^"]+)"/);
      const allow = body.match(/commands\.allow\s*=\s*\[([^\]]*)\]/);
      if (!id || !allow || !ids.includes(id[1])) continue;
      for (const m of allow[1].matchAll(/"([^"]+)"/g)) allowed.add(m[1]);
    }
    // A granted `allow-<kebab-command>` needs no block: Tauri generates it from
    // the `build.rs` command list. Only when the file DEFINES no block of that
    // name, though. Deriving the command from the identifier unconditionally is
    // what made the first version of this check inert: `allow-export-path` with
    // a block allowing `export_pathh` still contributed `export_path`, so the
    // typo this rule exists for passed. The name is a claim; the block is the
    // grant, and where both exist the block is what Tauri reads.
    for (const id of ids) {
      if (id.startsWith("allow-") && !defined.has(id)) {
        allowed.add(id.slice("allow-".length).replaceAll("-", "_"));
      }
    }
    for (const command of declared.get(plugin) ?? []) {
      if (allowed.has(command)) continue;
      fail(
        `${file}: \`build.rs\` declares \`${plugin}\` command "${command}" and no permission in ` +
          `the \`[default]\` set allows it, so \`plugin:${plugin}|${command}\` is refused at ` +
          `runtime. A one-character typo in a \`commands.allow\` entry produces exactly this, and ` +
          `it passes every other check in this file.`,
      );
    }
  }

  // ── 2. The roster, both directions ──────────────────────────────────────
  for (const dir of dirs) {
    if (declared.has(dir)) continue;
    fail(
      `${PERMISSIONS_ROOT}/${dir}: no \`InlinedPlugin\` named "${dir}" in ${BUILD_RS}. Without ` +
        `that declaration the permissions here flatten into \`__app-acl__\` and never match the ` +
        `\`plugin:${dir}|<cmd>\` form Tauri authorizes, so this directory is either stale or ` +
        `inert. A roster nobody prunes stops describing the tree.`,
    );
  }
  for (const plugin of declared.keys()) {
    if (granted.includes(plugin)) continue;
    if (plugin in UNGRANTED_PLUGINS) continue;
    fail(
      `${BUILD_RS}: declares an \`InlinedPlugin\` "${plugin}" that ${CAPABILITIES} never grants, ` +
        `so every command in it is refused at runtime. If that is deliberate, add \`${plugin}\` ` +
        `to UNGRANTED_PLUGINS with the reason; an accidentally ungranted plugin is a feature that ` +
        `silently does nothing.`,
    );
  }

  // ── 3. Both exemption lists describe the tree ───────────────────────────
  for (const [name, reason] of Object.entries(EXTERNAL_GRANTS)) {
    if (!reason || reason.length < 20) {
      fail(`EXTERNAL_GRANTS["${name}"] carries no usable reason.`);
    }
    if (io.exists(`${PERMISSIONS_ROOT}/${name}/default.toml`)) {
      fail(
        `EXTERNAL_GRANTS lists "${name}" as living outside this repository, and ` +
          `${PERMISSIONS_ROOT}/${name}/default.toml exists. Remove the exemption; it is now ` +
          `describing a file it would skip.`,
      );
    }
    if (granted.length > 0 && !granted.includes(name)) {
      fail(
        `EXTERNAL_GRANTS lists "${name}", which ${CAPABILITIES} does not grant. A stale exemption ` +
          `outlives the thing it exempts and hides the next one.`,
      );
    }
  }
  for (const [name, reason] of Object.entries(UNGRANTED_PLUGINS)) {
    if (!reason || reason.length < 20) {
      fail(`UNGRANTED_PLUGINS["${name}"] carries no usable reason.`);
    }
    if (declared.size > 0 && !declared.has(name)) {
      fail(
        `UNGRANTED_PLUGINS lists "${name}", which ${BUILD_RS} no longer declares. Remove the ` +
          `stale exemption.`,
      );
    }
    if (granted.includes(name)) {
      fail(
        `UNGRANTED_PLUGINS lists "${name}" as deliberately ungranted, and ${CAPABILITIES} grants ` +
          `it. One of the two is wrong.`,
      );
    }
  }

  return { failures, plugins: declared.size, dirs: dirs.length, grants: granted.length };
}

// ── Report ─────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { failures, plugins, dirs, grants } = analyse(diskIo());
  if (failures.length > 0) {
    console.error("mobile plugin ACL lockstep: FAILED");
    for (const message of failures) console.error(`  - ${message}`);
    console.error(
      "\n  Why this is a gate: a capability that resolves to an empty permission set refuses\n" +
        "  every call in its plugin at runtime, on a green build, with nothing in the tree\n" +
        "  reporting it. The feature is simply inert. See the header for the tauri-utils arm.",
    );
    process.exit(1);
  }
  console.log(
    `mobile plugin ACL lockstep: ok (${plugins} inlined plugin(s), ${dirs} permission ` +
      `director(ies), ${grants} \`:default\` grant(s))`,
  );
}
