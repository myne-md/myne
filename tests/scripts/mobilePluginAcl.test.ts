// Unit tests for `scripts/check-mobile-plugin-acl.mjs` (myne-md/myne#517).
//
// The guard exists for one failure that nothing else in the tree reports: a
// `<plugin>:default` capability grant whose permission file is missing or
// malformed resolves to an EMPTY permission set with no build error, so every
// command in that plugin is refused at runtime and the feature is simply inert.
// It was found by injection against the real tree, and it is re-injected here.
//
// The repo rule is that verifying a guard means BREAKING it, and the sharper
// half is proving the TESTS fail on a bad GUARD, not only that the guard fails
// on a bad tree. Both directions are exercised: each case below mutates a
// synthetic tree, and `progress.md` records the companion pass where checks
// inside the guard were disabled one at a time.

import { describe, expect, it } from "vitest";

import {
  BUILD_RS,
  CAPABILITIES,
  EXTERNAL_GRANTS,
  PERMISSIONS_ROOT,
  UNGRANTED_PLUGINS,
  analyse,
  stripTomlComments,
  tomlTables,
} from "../../scripts/check-mobile-plugin-acl.mjs";

const NOTES_TOML = `# Permissions for the notes plugin.
[default]
description = "Default permission set for notes."
permissions = ["allow-note-create", "allow-note-read"]

[[permission]]
identifier = "allow-note-create"
description = "Allow invoking notes:note_create."
commands.allow = ["note_create"]

[[permission]]
identifier = "allow-note-read"
description = "Allow invoking notes:note_read."
commands.allow = ["note_read"]

[[permission]]
identifier = "deny-note-create"
description = "Deny invoking notes:note_create."
commands.deny = ["note_create"]
`;

const EXPORT_DIR_TOML = `[default]
description = "Default permission set for export-dir."
permissions = ["allow-export-path"]

[[permission]]
identifier = "allow-export-path"
description = "Allow invoking export-dir:export_path."
commands.allow = ["export_path"]
`;

/** A tree that passes every rule, as the baseline each defect mutates. */
function healthyFiles(): Record<string, string> {
  return {
    [BUILD_RS]: `fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin(
                "notes",
                tauri_build::InlinedPlugin::new().commands(&["note_create", "note_read"]),
            )
            .plugin(
                "export-dir",
                tauri_build::InlinedPlugin::new().commands(&["export_path"]),
            )
            .plugin(
                // Declared so the namespace exists; granted only when the
                // feature registers the plugin.
                "local-inference",
                tauri_build::InlinedPlugin::new().commands(&["transcribe"]),
            ),
    )
    .unwrap();
}
`,
    // Every name in EXTERNAL_GRANTS appears here, because the guard checks that
    // list BOTH ways and an exemption for a grant the tree does not carry is a
    // stale exemption. That makes this fixture a faithful miniature rather than
    // a convenient subset, which is the right trade: a fixture that cannot hold
    // the real shape cannot hold the real defect either.
    [CAPABILITIES]: `{
  "identifier": "default",
  "permissions": [
    "core:event:default",
    "core:window:default",
    "opener:default",
    "deep-link:default",
    "qr-scan:default",
    "reminders:default",
    "sensitive-clipboard:default",
    "notes:default",
    "export-dir:default"
  ]
}
`,
    [`${PERMISSIONS_ROOT}/notes/default.toml`]: NOTES_TOML,
    [`${PERMISSIONS_ROOT}/export-dir/default.toml`]: EXPORT_DIR_TOML,
  };
}

function run(files: Record<string, string>) {
  return analyse({
    exists: (rel: string) => rel in files,
    read: (rel: string) => {
      if (!(rel in files)) throw new Error(`missing ${rel}`);
      return files[rel];
    },
    listPermissionDirs: () =>
      [
        ...new Set(
          Object.keys(files)
            .filter((f) => f.startsWith(`${PERMISSIONS_ROOT}/`))
            .map((f) => f.slice(PERMISSIONS_ROOT.length + 1).split("/")[0]),
        ),
      ].sort(),
  }) as { failures: string[]; plugins: number; dirs: number; grants: number };
}

const messages = (files: Record<string, string>) => run(files).failures.join("\n");

describe("the baseline is green", () => {
  it("passes, so every case below fails for its own reason", () => {
    expect(run(healthyFiles()).failures).toEqual([]);
  });

  it("really parsed the rosters it claims to, rather than empty ones", () => {
    // The vacuity floor. Every rule below iterates one of these three, so a
    // parse that came back empty would make the whole file pass over any tree.
    const out = run(healthyFiles());
    expect(out.plugins).toBe(3);
    expect(out.dirs).toBe(2);
    expect(out.grants).toBe(9);
  });
});

describe("the discovery: a grant that resolves to an empty permission set", () => {
  it("fails when the permission file is deleted, which leaves cargo build GREEN", () => {
    // Verified against the real tree: `cargo check -p myne-mobile` stays green
    // and the generated manifest shows `default_permission: None`, because
    // tauri-utils maps a missing default to `Ok(Default::default())`.
    const files = healthyFiles();
    delete files[`${PERMISSIONS_ROOT}/notes/default.toml`];
    const out = messages(files);
    expect(out).toContain('grants `"notes:default"`');
    expect(out).toContain("EMPTY permission set with no build error");
  });

  it("fails for a SECOND plugin too, so the widening is real", () => {
    // The whole point of extracting this guard: the property holds for all 27
    // mobile permission directories, and the version it came from covered one.
    const files = healthyFiles();
    delete files[`${PERMISSIONS_ROOT}/export-dir/default.toml`];
    expect(messages(files)).toContain('grants `"export-dir:default"`');
  });

  it("fails when the [default] table is removed but the permissions remain", () => {
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/notes/default.toml`] = NOTES_TOML.replace(
      /\[default\][\s\S]*?(?=\[\[permission\]\])/,
      "",
    );
    expect(messages(files)).toContain("no `[default]` table");
  });

  it("fails when the [default] permission LIST is commented out", () => {
    // Needs the comment stripper: the regex matches a commented line happily.
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/notes/default.toml`] = NOTES_TOML.replace(
      'permissions = ["allow-note-create", "allow-note-read"]',
      '#permissions = ["allow-note-create", "allow-note-read"]',
    );
    expect(messages(files)).toContain("carries no `permissions = [...]` list");
  });

  it("fails when the [default] list is present and empty", () => {
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/notes/default.toml`] = NOTES_TOML.replace(
      'permissions = ["allow-note-create", "allow-note-read"]',
      "permissions = []",
    );
    expect(messages(files)).toContain("permission list is empty");
  });

  it("fails when a granted permission names no command at all", () => {
    // The shape a commented-out `commands.allow` leaves: the `identifier` line
    // survives, so the permission exists and is granted, and it authorizes
    // nothing. This is the one check the extraction initially LOST, found by
    // re-running every old rule-5 injection against the new guard rather than
    // by reading the diff.
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/notes/default.toml`] = NOTES_TOML.replace(
      'commands.allow = ["note_create"]',
      '#commands.allow = ["note_create"]',
    );
    expect(messages(files)).toContain("names no command in either");
  });

  it("fails when a granted permission allows the WRONG command", () => {
    // The second check the extraction lost, and the one the enumeration found:
    // the guard asked whether a granted permission names SOME command and never
    // which. `commands.allow = ["note_createe"]` satisfies every other rule here
    // and refuses `plugin:notes|note_create` at runtime.
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/notes/default.toml`] = NOTES_TOML.replace(
      'commands.allow = ["note_create"]',
      'commands.allow = ["note_createe"]',
    );
    const out = messages(files);
    expect(out).toContain('declares `notes` command "note_create"');
    expect(out).toContain("refused at runtime");
  });

  it("does not require a command build.rs never declared, which is optional there", () => {
    // ONE direction only. Naming a command in `InlinedPlugin::commands` is
    // optional (`src-tauri/CLAUDE.md`), so a permission may allow more than
    // `build.rs` lists. Requiring the reverse would fail `prefs`, most of whose
    // commands appear in no list.
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/notes/default.toml`] = NOTES_TOML.replace(
      'commands.allow = ["note_read"]',
      'commands.allow = ["note_read", "note_never_declared"]',
    );
    expect(run(files).failures).toEqual([]);
  });

  it("does not let an allow- identifier NAME stand in for what its block allows", () => {
    // The first version of the rule above derived the command from the
    // identifier unconditionally, so `allow-note-create` contributed
    // `note_create` no matter what its block said, and the typo it exists for
    // passed. A name is a claim; the block is the grant.
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/notes/default.toml`] = NOTES_TOML.replace(
      'commands.allow = ["note_create"]',
      'commands.allow = ["something_else"]',
    );
    expect(messages(files)).toContain('declares `notes` command "note_create"');
  });

  it("fails when the [default] set names a permission nothing defines", () => {
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/notes/default.toml`] = NOTES_TOML.replace(
      '"allow-note-read"]',
      '"allow-note-read", "set-everything"]',
    );
    expect(messages(files)).toContain("names `set-everything`");
  });

  it("does not fire on an auto-generated allow- name with no block", () => {
    // The other direction: Tauri generates `allow-<command>` from the
    // InlinedPlugin command list, so those legitimately have no block.
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/notes/default.toml`] = NOTES_TOML.replace(
      '"allow-note-read"]',
      '"allow-note-read", "allow-note-delete"]',
    );
    expect(run(files).failures).toEqual([]);
  });
});

describe("deny wins, so a granted deny makes the command unreachable", () => {
  it("fails when the [default] set includes a permission that denies a command", () => {
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/notes/default.toml`] = NOTES_TOML.replace(
      '"allow-note-read"]',
      '"allow-note-read", "deny-note-create"]',
    );
    const out = messages(files);
    expect(out).toContain("`deny-note-create`, which DENIES note_create");
    expect(out).toContain("Tauri resolves deny over allow");
  });

  it("does not fire when the deny permission exists but is not granted", () => {
    // The shipped shape: `deny-note-create` is declared in the baseline fixture
    // and granted to nobody, and that must stay green.
    expect(NOTES_TOML).toContain('identifier = "deny-note-create"');
    expect(run(healthyFiles()).failures).toEqual([]);
  });

  it("attributes deny to the block it came from, not to its neighbour", () => {
    // Per-table parsing. A file-wide lazy regex credits `allow-note-read` with
    // the following block's `commands.deny` and fails the wrong permission.
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/notes/default.toml`] = NOTES_TOML;
    expect(run(files).failures).toEqual([]);
    expect(tomlTables(NOTES_TOML).filter((t) => t.header === "[[permission]]")).toHaveLength(3);
  });
});

describe("the roster, both directions", () => {
  it("fails on a permission directory with no InlinedPlugin behind it", () => {
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/ghost/default.toml`] = EXPORT_DIR_TOML;
    expect(messages(files)).toContain('no `InlinedPlugin` named "ghost"');
  });

  it("fails on an InlinedPlugin the capability never grants", () => {
    const files = healthyFiles();
    files[CAPABILITIES] = files[CAPABILITIES].replace('    "notes:default",\n', "");
    const out = messages(files);
    expect(out).toContain('declares an `InlinedPlugin` "notes" that');
    expect(out).toContain("never grants");
  });

  it("does not fire on a plugin recorded in UNGRANTED_PLUGINS", () => {
    // `local-inference` is in the baseline fixture, declared and ungranted, and
    // the tree it mirrors is the real one.
    expect(Object.keys(UNGRANTED_PLUGINS)).toContain("local-inference");
    expect(run(healthyFiles()).failures).toEqual([]);
  });
});

describe("the exemption lists describe the tree, both ways", () => {
  it("fails when an EXTERNAL_GRANTS name turns out to have an in-repo file", () => {
    const files = healthyFiles();
    files[`${PERMISSIONS_ROOT}/opener/default.toml`] = EXPORT_DIR_TOML;
    const out = messages(files);
    expect(out).toContain('EXTERNAL_GRANTS lists "opener"');
    expect(out).toContain("Remove the exemption");
  });

  it("fails when an EXTERNAL_GRANTS name is no longer granted", () => {
    const files = healthyFiles();
    files[CAPABILITIES] = files[CAPABILITIES].replace('    "opener:default",\n', "");
    expect(messages(files)).toContain("A stale exemption");
  });

  it("fails when an UNGRANTED_PLUGINS name IS granted after all", () => {
    const files = healthyFiles();
    files[CAPABILITIES] = files[CAPABILITIES].replace(
      '    "opener:default",',
      '    "opener:default",\n    "local-inference:default",',
    );
    expect(messages(files)).toContain("deliberately ungranted");
  });

  it("fails when an UNGRANTED_PLUGINS name is no longer declared", () => {
    const files = healthyFiles();
    files[BUILD_RS] = files[BUILD_RS].replace('"local-inference"', '"local-inference-v2"');
    expect(messages(files)).toContain("no longer declares");
  });

  it("every exemption carries a usable reason", () => {
    for (const reason of [
      ...Object.values(EXTERNAL_GRANTS),
      ...Object.values(UNGRANTED_PLUGINS),
    ]) {
      expect(reason.length).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("the guard fails loudly when it cannot read its input", () => {
  it("fails when build.rs is gone", () => {
    const files = healthyFiles();
    delete files[BUILD_RS];
    expect(messages(files)).toContain("this guard cannot know which plugins exist");
  });

  it("fails when build.rs parses to no plugins at all", () => {
    const files = healthyFiles();
    files[BUILD_RS] = "fn main() {}\n";
    expect(messages(files)).toContain("no `InlinedPlugin` declarations parsed");
  });

  it("fails when the permissions root is empty", () => {
    const out = analyse({
      exists: () => false,
      read: () => "",
      listPermissionDirs: () => [],
    }) as { failures: string[] };
    expect(out.failures.join("\n")).toContain("no permission directories found");
  });

  it("fails when the capability file is not valid JSON", () => {
    const files = healthyFiles();
    files[CAPABILITIES] = "{ not json";
    expect(messages(files)).toContain("is not valid JSON");
  });

  it("fails when the capability file has no permissions array", () => {
    const files = healthyFiles();
    files[CAPABILITIES] = '{ "identifier": "default" }';
    expect(messages(files)).toContain("has no `permissions` array");
  });

  it("is not fooled by an InlinedPlugin that exists only in a comment", () => {
    // Held by the PATTERN rather than by a comment stripper, which is why this
    // guard has none: the name and `InlinedPlugin::new()` must be separated by
    // whitespace alone, and a commented-out declaration has `//` between them.
    // A stripper was written here first; disabling it left every test green,
    // which is how it was found to be inert and then deleted.
    const files = healthyFiles();
    files[BUILD_RS] = files[BUILD_RS].replace(
      "            .plugin(\n                \"notes\",",
      "            // .plugin(\n            //     \"ghost\",\n"
        + "            //     tauri_build::InlinedPlugin::new().commands(&[\"gone\"]),\n"
        + "            // )\n            .plugin(\n                \"notes\",",
    );
    expect(run(files).failures).toEqual([]);
    expect(run(files).plugins).toBe(3);
  });
});

describe("the helpers", () => {
  it("strips a full-line # and leaves a mid-line one alone", () => {
    expect(stripTomlComments("# gone\nkept = 1\n")).toBe("\nkept = 1\n");
    expect(stripTomlComments('d = "see myne#517"')).toBe('d = "see myne#517"');
  });

  it("splits tables so an answer belongs to the block it came from", () => {
    const tables = tomlTables(NOTES_TOML);
    expect(tables[0].header).toBe("[default]");
    expect(tables[1].body).toContain('identifier = "allow-note-create"');
    expect(tables[1].body).not.toContain("allow-note-read");
  });
});
