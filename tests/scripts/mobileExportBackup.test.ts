// Unit tests for `scripts/check-mobile-export-backup.mjs` (myne-md/myne#491,
// redesigned for the chokepoint in myne-md/myne#517).
//
// The repo rule is that verifying a guard means BREAKING it, and the sharper
// half of that rule is the one this file exists for: a guard fix verified by
// "the tree is still green afterwards" is non-evidence, and closing one blind
// spot can open another one line away. So every rule that SURVIVED the redesign
// is re-injected here in both directions, it must still catch what it caught
// before myne#517, not only what it started catching.
//
// The map from rule to describe block, so a future edit can tell what it broke:
//
//   rule 0  (INVERTED: the seam reaches no path accessor)  → "drift class 1"
//   rule 2  (Android rules XML, both blocks, both files)   → "drift class 2"
//   rule 3  (library manifest attributes) + 3b (merged)    → "drift class 3"
//   rule 4  (the Rust roster, now a type)                  → "drift class 4"
//   rule 5  (the chokepoint's five ACL sites)              → "drift class 5"
//
// `analyse(io)` takes its whole world as an argument, so each defect below is a
// synthetic file set rather than a mutation of the real tree, no `git restore`,
// no risk of a half-restored working copy, and every case runs on every commit.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  ANDROID_MANIFEST,
  ANDROID_RULES_LEGACY,
  ANDROID_RULES_MODERN,
  BUILD_RS,
  CAPABILITIES,
  PATH_SEAM,
  PLUGIN_MODULE,
  RUST_MODULE,
  RUST_SETUP,
  SEAM_DIR,
  analyse,
  diskIo,
  excludedPaths,
  stripRustComments,
  stripTsComments,
  stripXmlComments,
} from "../../scripts/check-mobile-export-backup.mjs";

/**
 * A file set that passes every rule, as the baseline each defect mutates.
 *
 * **TWO `ExportDir` variants, and that is load-bearing rather than incidental.**
 * With one, every way of losing a directory from `requiredDirs` empties it, so
 * the vacuity floor answers and no rule-4b-i case can ever be the reason a run
 * is red: reverting the whole of 4b-i left this spec 66/66 green while the
 * defect it closes was live (review round 6, F1). A second variant is what lets
 * the roster SHRINK without emptying, which is the only state in which the
 * drop-one-directory defect is distinguishable from the read-nothing one.
 *
 * `Pictures` rather than `Downloads`, deliberately: three cases below ADD a
 * `Downloads` variant themselves, and a baseline that already held one would
 * turn each of them into a duplicate-variant fixture testing something else.
 */
function healthyFiles(): Record<string, string> {
  return {
    [PATH_SEAM]: `import { invoke } from "./core";
export function exportPath(filename: string) {
  return invoke("plugin:export-dir|export_path", { filename });
}
`,
    [ANDROID_RULES_MODERN]: `<?xml version="1.0" encoding="utf-8"?>
<!-- A comment that mentions <device-transfer> and <cloud-backup> in prose. -->
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="external" path="Documents" />
        <exclude domain="external" path="Pictures" />
        <exclude domain="file" path="person-auth.json" />
    </cloud-backup>
    <device-transfer>
        <exclude domain="external" path="Documents" />
        <exclude domain="external" path="Pictures" />
        <exclude domain="file" path="person-auth.json" />
    </device-transfer>
</data-extraction-rules>
`,
    [ANDROID_RULES_LEGACY]: `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
    <exclude domain="external" path="Documents" />
    <exclude domain="external" path="Pictures" />
    <exclude domain="file" path="person-auth.json" />
</full-backup-content>
`,
    [ANDROID_MANIFEST]: `<manifest>
    <application
        android:dataExtractionRules="@xml/myne_backup_rules"
        android:fullBackupContent="@xml/myne_backup_rules_legacy" />
</manifest>
`,
    [RUST_MODULE]: `pub enum ExportDir {
    Documents,
    Pictures,
}

impl ExportDir {
    pub const ALL: &'static [ExportDir] = &[ExportDir::Documents, ExportDir::Pictures];

    pub const fn name(self) -> &'static str {
        match self {
            ExportDir::Documents => "Documents",
            ExportDir::Pictures => "Pictures",
        }
    }

    fn resolve<R: tauri::Runtime>(
        self,
        resolver: &tauri::path::PathResolver<R>,
    ) -> tauri::Result<std::path::PathBuf> {
        match self {
            ExportDir::Documents => resolver.document_dir(),
            ExportDir::Pictures => resolver.picture_dir(),
        }
    }
}

pub const EXPORT_DESTINATION: ExportDir = ExportDir::Documents;

pub fn ensure_export_dir<R>(app: &AppHandle<R>) -> Result<PathBuf, EnsureError> {
    ensure(app, EXPORT_DESTINATION)
}

pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_config_dir() {
        let path = dir.to_string_lossy().to_string();
        let _ = exclude_from_backup_at(&path);
    }
}
`,
    [RUST_SETUP]: `mod backup_exclude;
fn run() {
    builder.plugin(plugins::export_dir::init());
}
fn setup() { backup_exclude::init(app.handle()); }
`,
    [PLUGIN_MODULE]: `#[tauri::command]
fn export_path<R: Runtime>(app: AppHandle<R>, filename: String) -> Result<ExportPath, ExportDirError> {
    let dir = backup_exclude::ensure_export_dir(&app)?;
    Ok(build(dir, filename))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("export-dir")
        .invoke_handler(tauri::generate_handler![export_path])
        .build()
}
`,
    [BUILD_RS]: `fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "export-dir",
            tauri_build::InlinedPlugin::new().commands(&["export_path"]),
        ),
    )
    .unwrap();
}
`,
    [CAPABILITIES]: `{
  "identifier": "default",
  "permissions": ["core:event:default", "export-dir:default"]
}
`,
  };
}

/** Drive `analyse` over a synthetic file set. */
function run(files: Record<string, string>, mergedManifests: Record<string, string> = {}) {
  const all = { ...files, ...mergedManifests };
  return analyse({
    exists: (rel: string) => rel in all,
    read: (rel: string) => {
      if (!(rel in all)) throw new Error(`missing ${rel}`);
      return all[rel];
    },
    // Rule 0 reads the seam DIRECTORY, so the fixture has to be able to put a
    // second file in it. That is the whole of finding F1: the guard read one
    // file where `check-platform-seam.mjs` exempts a directory.
    listSeam: () =>
      Object.keys(files)
        .filter((f) => f.startsWith(`${SEAM_DIR}/`) && /\.(ts|tsx)$/.test(f))
        .sort(),
    listMergedManifests: () => Object.keys(mergedManifests),
  }) as { failures: string[]; requiredDirs: Set<string>; mergedManifests: number };
}

/** Every failure message joined, for substring assertions. */
const messages = (files: Record<string, string>, merged?: Record<string, string>) =>
  run(files, merged).failures.join("\n");

describe("the baseline is green", () => {
  it("passes with no failures, so every case below fails for its own reason", () => {
    // A non-vacuity floor: if the healthy set failed, every "it fails" assertion
    // below would pass for the wrong reason.
    expect(run(healthyFiles()).failures).toEqual([]);
  });

  it("derives its directory roster from the Rust enum, rather than from a constant", () => {
    // This replaces the old `expect(ROSTER.length).toBeGreaterThanOrEqual(4)`,
    // which disappeared with the roster it counted. What makes this version
    // non-vacuous is the second half: it does not merely assert a value, it
    // MOVES the value in the fixture and requires the guard's answer to move
    // with it. A guard that had stopped parsing the Rust and was reporting a
    // hardcoded set would pass the first assertion and fail the second.
    expect([...run(healthyFiles()).requiredDirs]).toEqual(["Documents", "Pictures"]);

    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      'ExportDir::Documents => "Documents",',
      'ExportDir::Documents => "Papers",',
    );
    expect([...run(files).requiredDirs]).toEqual(["Papers", "Pictures"]);
  });

  it("fails rather than passing when the roster comes back empty", () => {
    // The direction that matters more than any single rule: rules 2 and 3
    // iterate the roster, so an empty one makes both of them pass over any
    // Android file at all. The guard has to say it read nothing.
    //
    // BOTH variants are removed, because the fixture now declares two. This is
    // the intersection case as well as the vacuity one: the `name()` arms are
    // deliberately left in place, so `named` is non-empty while `variants` is
    // empty, which is exactly the state the rejected `named`-driven design
    // would have walked straight past with a roster of two.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE]
      .replace("    Documents,\n", "")
      .replace("    Pictures,\n", "");
    const out = messages(files);
    expect(out).toContain("the directory roster came back EMPTY");
    expect(out).toContain("rules 2 and 3 below checked no directory");
  });
});

describe("drift class 1: the seam reaches for a path accessor again (rule 0, inverted)", () => {
  // Every case in this block is one the PRE-myne#517 guard caught, plus the two
  // the inversion adds. The pre-existing ones are kept verbatim in intent
  // because the repo rule is to prove a rule still catches what it caught
  // BEFORE the edit, not only what it missed.

  it("fails on an accessor nothing excludes on either platform", () => {
    const files = healthyFiles();
    files[PATH_SEAM] = `export { downloadDir } from "@tauri-apps/api/path";\n`;
    const out = messages(files);
    expect(out).toContain("re-exports `downloadDir`");
    expect(out).toContain("nothing excludes that directory");
    expect(out).toContain("iCloud / Google Drive");
  });

  it("fails on an accessor the guard has never classified", () => {
    const files = healthyFiles();
    files[PATH_SEAM] = `export { cacheDir } from "@tauri-apps/api/path";\n`;
    const out = messages(files);
    expect(out).toContain("re-exports `cacheDir`");
    expect(out).toContain("it is an accessor this guard has never classified");
  });

  it("reads through an alias, since the local name is what a consumer calls", () => {
    const files = healthyFiles();
    files[PATH_SEAM] = `export { downloadDir as dl } from "@tauri-apps/api/path";\n`;
    expect(messages(files)).toContain("never classified");
  });

  it("fails when the seam reaches api/path in a shape the guard cannot read", () => {
    // Silence would be the wrong answer: a guard that cannot find its input has
    // stopped checking, and that is exactly when it prints ok.
    const files = healthyFiles();
    files[PATH_SEAM] = `import * as path from "@tauri-apps/api/path";\nexport default path;\n`;
    expect(messages(files)).toContain("teach the guard the new shape");
  });

  it("NEW after the inversion: fails on documentDir, which IS excluded", () => {
    // The case the old rule deliberately allowed, and the reason the rule had to
    // invert rather than be deleted. The directory is excluded; the sanitizer
    // and the mkdir-then-exclude ordering are not applied to a path the WebView
    // composed for itself.
    const files = healthyFiles();
    files[PATH_SEAM] =
      `import { invoke } from "./core";\n` +
      `export { documentDir } from "@tauri-apps/api/path";\n` +
      `export const exportPath = (f: string) => invoke("plugin:export-dir|export_path", { f });\n`;
    const out = messages(files);
    expect(out).toContain("re-exports `documentDir`");
    expect(out).toContain("IS excluded");
    expect(out).toContain("is not the same as safe");
  });

  it("NEW after the inversion: fails on join, the path arithmetic half", () => {
    const files = healthyFiles();
    files[PATH_SEAM] =
      `import { invoke } from "./core";\n` +
      `export { join } from "@tauri-apps/api/path";\n` +
      `export const exportPath = (f: string) => invoke("plugin:export-dir|export_path", { f });\n`;
    const out = messages(files);
    expect(out).toContain("re-exports `join`");
    expect(out).toContain("it is path arithmetic");
  });

  it("does not fire on a comment that discusses those accessors", () => {
    // The other direction, and it is live rather than theoretical: the shipped
    // seam's comment is thirty lines explaining why it no longer imports
    // `@tauri-apps/api/path`, and it names `documentDir` and `downloadDir` while
    // doing so. Without comment stripping the guard fails on its own
    // explanation, which is why `stripTsComments` outlived the call-site scan it
    // was written for.
    const files = healthyFiles();
    files[PATH_SEAM] =
      `// Do NOT re-add \`export { documentDir, downloadDir } from "@tauri-apps/api/path"\`.\n` +
      `/** @see pictureDir() and @tauri-apps/api/path */\n` +
      files[PATH_SEAM];
    expect(run(files).failures).toEqual([]);
  });

  it("fails when the path seam is gone", () => {
    const files = healthyFiles();
    delete files[PATH_SEAM];
    expect(messages(files)).toContain("looking at the wrong tree");
  });

  it("fails on a SIBLING of path.ts, because the seam is a directory", () => {
    // F1, and it is the finding this whole block turns on. `check-platform-seam.mjs`
    // exempts `mobile/src/platform/` as a DIRECTORY, so a new file beside
    // `path.ts` may import `@tauri-apps/api/path` and compile. Rule 0 read one
    // file for a review round, and the tree-wide consumer scan that used to
    // close the gap had been deleted in the same change, so the two-step
    // (sibling re-export plus a consumer under `mobile/src/lib`) passed.
    const files = healthyFiles();
    files[`${SEAM_DIR}/files.ts`] = `export { downloadDir, join } from "@tauri-apps/api/path";\n`;
    const out = messages(files);
    expect(out).toContain(`${SEAM_DIR}/files.ts: re-exports \`downloadDir\``);
    expect(out).toContain("nothing excludes that directory");
    // Named by FILE, not by the seam constant: the author has to be told which
    // file to open, and there is now more than one candidate.
    expect(out).not.toContain(`${PATH_SEAM}: re-exports \`downloadDir\``);
  });

  it("fails when the seam directory is empty rather than reading nothing", () => {
    // The can-the-guard-read-its-input direction. A rule 0 that iterates an
    // empty list passes every tree there is, silently.
    const out = analyse({
      exists: () => false,
      read: () => "",
      listSeam: () => [],
      listMergedManifests: () => [],
    }) as { failures: string[] };
    expect(out.failures.join("\n")).toContain("no .ts/.tsx files found, so rule 0 read nothing");
  });
});

describe("drift class 2b: the person token is backed up", () => {
  it("fails when the Android 12+ rules stop excluding person-auth.json", () => {
    const files = healthyFiles();
    files[ANDROID_RULES_MODERN] = files[ANDROID_RULES_MODERN].replace(
      '        <exclude domain="file" path="person-auth.json" />\n',
      "",
    );
    const out = messages(files);
    expect(out).toContain("person-auth.json");
    expect(out).toContain("every vault the account is bound to");
  });

  it("fails when only the device-transfer half loses it, because that is a separate copy path", () => {
    const files = healthyFiles();
    files[ANDROID_RULES_MODERN] = files[ANDROID_RULES_MODERN].replace(
      '    <device-transfer>\n        <exclude domain="external" path="Documents" />\n        <exclude domain="external" path="Pictures" />\n        <exclude domain="file" path="person-auth.json" />',
      '    <device-transfer>\n        <exclude domain="external" path="Documents" />\n        <exclude domain="external" path="Pictures" />',
    );
    expect(messages(files)).toContain("person-auth.json");
  });

  it("fails when the iOS call stops naming the config directory", () => {
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      "if let Ok(dir) = app.path().app_config_dir() {",
      "if let Ok(dir) = Ok::<std::path::PathBuf, ()>(std::path::PathBuf::new()) {",
    );
    const out = messages(files);
    expect(out).toContain("app-config directory");
    expect(out).toContain("one platform fixed and the other silently not");
  });
});

describe("drift class 2: the Android rules fall behind", () => {
  it("fails when <device-transfer> is emptied", () => {
    const files = healthyFiles();
    files[ANDROID_RULES_MODERN] = files[ANDROID_RULES_MODERN].replace(
      /<device-transfer>[\s\S]*?<\/device-transfer>/,
      "<device-transfer>\n    </device-transfer>",
    );
    expect(messages(files)).toContain("<device-transfer> does not exclude");
  });

  it("fails when <cloud-backup> is emptied", () => {
    const files = healthyFiles();
    files[ANDROID_RULES_MODERN] = files[ANDROID_RULES_MODERN].replace(
      /<cloud-backup>[\s\S]*?<\/cloud-backup>/,
      "<cloud-backup>\n    </cloud-backup>",
    );
    expect(messages(files)).toContain("<cloud-backup> does not exclude");
  });

  it("fails when the API<=30 file falls behind the API-31+ one", () => {
    const files = healthyFiles();
    files[ANDROID_RULES_LEGACY] = `<full-backup-content>\n</full-backup-content>\n`;
    expect(messages(files)).toContain("ignored below API 31");
  });

  it("fails when a rules file is deleted outright", () => {
    const files = healthyFiles();
    delete files[ANDROID_RULES_LEGACY];
    expect(messages(files)).toContain("every Android <= 11 device backs the exports up");
  });

  it("is not fooled by a block name that appears only in a comment", () => {
    // The exact defect the guard's header records, reproduced rather than
    // approximated. The shape needs three things at once: a comment that opens
    // `<device-transfer>` in prose, a real `<cloud-backup>` that DOES carry the
    // exclude, and a real `<device-transfer>` that does NOT. Without comment
    // stripping the lazy regex anchors on the comment's mention and runs to the
    // real closing tag, so the matched "device-transfer body" contains
    // cloud-backup's exclude and the guard reports ok on a file that leaves the
    // phone-to-phone copy path wide open.
    //
    // A fixture where the comment mentions only the opening tag does NOT
    // reproduce it: with no closing tag to reach, the match fails either way and
    // the test passes against a guard that has stopped stripping. That version
    // was written first and caught nothing.
    //
    // And `<cloud-backup>` must exclude EVERY directory the roster requires,
    // which is why `Pictures` is here beside `Documents`. Leave one unmet and
    // the assertion below fires for that directory whether or not stripping
    // works, so the case passes against an identity stripper. It did, for as
    // long as the baseline held one variant and this fixture held one exclude.
    const files = healthyFiles();
    files[ANDROID_RULES_MODERN] = `<?xml version="1.0"?>
<!--
  BOTH blocks are required. <device-transfer> covers phone-to-phone transfer,
  which ignores the <cloud-backup> block entirely.
-->
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="external" path="Documents" />
        <exclude domain="external" path="Pictures" />
    </cloud-backup>
    <device-transfer>
    </device-transfer>
</data-extraction-rules>
`;
    expect(messages(files)).toContain("<device-transfer> does not exclude");
  });

  it("is not fooled by an <exclude> that appears only in a comment", () => {
    // `Pictures` is excluded for real so that `Documents` is the ONLY unmet
    // directory, and it is reachable only through the comment. Without that,
    // the assertion fires for `Pictures` regardless and the case passes against
    // a guard that has stopped stripping.
    const files = healthyFiles();
    files[ANDROID_RULES_LEGACY] = `<?xml version="1.0"?>
<full-backup-content>
    <exclude domain="external" path="Pictures" />
    <!-- <exclude domain="external" path="Documents" /> was here; see myne#491 -->
</full-backup-content>
`;
    expect(messages(files)).toContain("ignored below API 31");
  });

  it("compares against the directory the Rust roster names, not a literal", () => {
    // The link between rule 4 and rule 2, which is the whole reason the roster
    // moved into Rust. Rename the directory on the Rust side alone and the
    // Android files must be reported as not excluding it.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      'ExportDir::Documents => "Documents",',
      'ExportDir::Documents => "Papers",',
    );
    const out = messages(files);
    expect(out).toContain('does not exclude domain="external" path="Papers"');
  });
});

describe("drift class 3: the manifest stops pointing at the rules", () => {
  it("fails when an attribute is removed", () => {
    const files = healthyFiles();
    files[ANDROID_MANIFEST] = files[ANDROID_MANIFEST].replace(
      /\s*android:fullBackupContent="[^"]*"/,
      "",
    );
    expect(messages(files)).toContain("no `android:fullBackupContent`");
  });

  it("is not satisfied by an attribute that appears only in a comment", () => {
    // Same hole, third file. The manifest documents these two attributes in
    // prose immediately above them, so a deletion that leaves the prose behind
    // is the realistic shape of this failure.
    const files = healthyFiles();
    files[ANDROID_MANIFEST] = `<manifest>
    <!-- android:fullBackupContent="@xml/myne_backup_rules_legacy" keeps the
         export directory out of Auto Backup on API <= 30. -->
    <application android:dataExtractionRules="@xml/myne_backup_rules" />
</manifest>
`;
    expect(messages(files)).toContain("no `android:fullBackupContent`");
  });

  it("fails when an attribute points at a resource that does not exist", () => {
    const files = healthyFiles();
    files[ANDROID_MANIFEST] = files[ANDROID_MANIFEST].replace(
      "@xml/myne_backup_rules_legacy",
      "@xml/some_other_rules",
    );
    expect(messages(files)).toContain('expected "@xml/myne_backup_rules_legacy"');
  });

  it("fails when the MERGED manifest loses what the committed one declares", () => {
    // The one link the committed files cannot speak for: merger precedence.
    const merged = {
      "mobile/src-tauri/gen/android/app/build/intermediates/merged_manifests/x/AndroidManifest.xml": `<manifest>
    <application android:dataExtractionRules="@xml/myne_backup_rules" />
</manifest>
`,
    };
    const out = messages(healthyFiles(), merged);
    expect(out).toContain("the MERGED manifest carries no `android:fullBackupContent`");
    // The TAIL of the message, not only its prefix. Asserting the prefix alone
    // is what let the em-dash pass silently drop this rule's destructure
    // elision, so the message printed a file path where the API level belongs
    // and every test stayed green.
    expect(out).toContain("API <= 30 devices back the export directory up");
    expect(out).not.toContain("myne_backup_rules_legacy.xml devices");
  });

  it("reports that it compared NOTHING when no merged manifest is present", () => {
    // Rule 3b is opportunistic, and its report used to be byte-identical
    // whether it had checked merger precedence or skipped it entirely. Two
    // reviewers in a row believed it had run. The count is part of the returned
    // shape, so a caller can tell; the `ok` line now says so too.
    expect(run(healthyFiles()).mergedManifests).toBe(0);
    const merged = {
      "mobile/src-tauri/gen/android/app/build/intermediates/merged_manifests/x/AndroidManifest.xml":
        healthyFiles()[ANDROID_MANIFEST],
    };
    expect(run(healthyFiles(), merged).mergedManifests).toBe(1);
  });

  it("passes when the merged manifest agrees", () => {
    const merged = {
      "mobile/src-tauri/gen/android/app/build/intermediates/merged_manifests/x/AndroidManifest.xml":
        healthyFiles()[ANDROID_MANIFEST],
    };
    expect(run(healthyFiles(), merged).failures).toEqual([]);
  });
});

describe("drift class 4: the iOS roster stops matching", () => {
  it("fails when backup_exclude::init is dropped from the setup hook", () => {
    const files = healthyFiles();
    files[RUST_SETUP] = files[RUST_SETUP].replace("backup_exclude::init(app.handle());", "");
    expect(messages(files)).toContain("the shipped-inert shape");
  });

  it("fails when `mod backup_exclude;` is not declared", () => {
    const files = healthyFiles();
    files[RUST_SETUP] = files[RUST_SETUP].replace("mod backup_exclude;\n", "");
    expect(messages(files)).toContain("`mod backup_exclude;` is not declared");
  });

  it("fails when the roster is renamed out from under the guard", () => {
    // The direction the pre-myne#517 guard held with a regex over
    // `EXCLUDED_DIRS: &[&str]`, kept: a roster the guard cannot find must fail
    // BY NAME rather than report ok on an input it could not read.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace("pub enum ExportDir", "pub enum BackupDir");
    const out = messages(files);
    expect(out).toContain("could not find `pub enum ExportDir");
    expect(out).toContain("did it get renamed?");
  });

  it("fails when `name()` is renamed out from under the guard", () => {
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace("fn name(self)", "fn dir_name(self)");
    expect(messages(files)).toContain("could not find `fn name(self) -> &'static str`");
  });

  it("fails when `ALL` is renamed out from under the guard", () => {
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace("ALL: &'static [ExportDir]", "EVERY: &'static [ExportDir]");
    expect(messages(files)).toContain("could not find `ALL: &'static [ExportDir]");
  });

  it("fails on a variant hidden behind a TRAILING // comment", () => {
    // N1, and it is the whole of why `stripRustComments` stopped being a
    // line-anchored regex. `Downloads, // note` failed the variant filter, so
    // the variant vanished from `variants`, from `inAll` AND from
    // `requiredDirs`, which is what rules 2 and 3 hold the Android XML to. One
    // ordinary trailing note hid an export directory from the entire guard.
    //
    // Asserting rule 4a's message specifically is what makes this distinguish
    // the two mechanisms: with a line-anchored stripper the line survives and
    // trips the unparseable-line check below instead, which is a different
    // failure and a weaker one.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      "    Documents,\n",
      "    Documents,\n    Downloads, // the second export destination\n",
    ).replace(
      'ExportDir::Documents => "Documents",',
      'ExportDir::Documents => "Documents",\n            ExportDir::Downloads => "Downloads",',
    );
    expect(messages(files)).toContain(
      "`ExportDir::Downloads` is declared and is absent from `ExportDir::ALL`",
    );
  });

  it("fails BY NAME on an enum line it cannot parse, rather than dropping it", () => {
    // The generalisation of N1. A filter that silently discards what it does not
    // recognise will lose the next shape too, and a dropped variant is absent
    // from the roster, from `ALL` and from the Android comparison all at once.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      "    Documents,\n",
      "    Documents,\n    Downloads = 1,\n",
    );
    const out = messages(files);
    expect(out).toContain("holds a line this guard cannot parse as a variant");
    expect(out).toContain('"Downloads = 1,"');
  });

  it("does not fire on a blank line or an attribute inside the enum", () => {
    // The other direction: the two legitimate non-variants must not fail.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      "    Documents,\n",
      "\n    #[cfg_attr(not(target_os = \"ios\"), allow(dead_code))]\n    Documents,\n",
    );
    expect(run(files).failures).toEqual([]);
  });

  it("fails on the hole the enum OPENS: a variant that is missing from ALL", () => {
    // The reason `ExportDir::ALL` is compared at all. `resolve()` and `name()`
    // are exhaustive matches, so this variant is fully wired and the compiler is
    // satisfied; it is simply never walked at startup.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE]
      .replace("    Documents,\n", "    Documents,\n    Downloads,\n")
      .replace(
        'ExportDir::Documents => "Documents",',
        'ExportDir::Documents => "Documents",\n            ExportDir::Downloads => "Downloads",',
      );
    const out = messages(files);
    expect(out).toContain("`ExportDir::Downloads` is declared and is absent from `ExportDir::ALL`");
    expect(out).toContain("the compiler is satisfied");
  });

  it("fails on a `_ =>` catch-all in name(), which compiles and answers for everything", () => {
    // The missing-arm case this replaces is E0004 and was two messages for a
    // defect the compiler already refuses. A catch-all is the live one: it
    // builds, and every future variant silently inherits some other directory's
    // name.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      'ExportDir::Documents => "Documents",',
      'ExportDir::Documents => "Documents",\n            _ => "Documents",',
    );
    expect(messages(files)).toContain("`name()` has a `_ =>` catch-all");
  });

  // ── rule 4b-i: a directory may not leave `requiredDirs` SILENTLY ──────────
  //
  // Each of the three cases below asserts its own message AND asserts that the
  // vacuity floor did NOT fire. The second half is the point. Reverting 4b-i to
  // the `if (dir && inAll.has(variant))` it replaced left this whole spec green
  // (review round 6, F1), because the fixture held one variant, so every drop
  // emptied the roster and the floor answered for a check that was doing
  // nothing. Asserting the floor is ABSENT is what stops that recurring: a case
  // that starts passing for the floor's reason fails here instead.
  //
  // The acceptance test is per case, not per suite. Revert 4b-i and each of
  // these three must go red on its own.

  it("fails when a name() arm is written in a shape it cannot read, rather than dropping the directory", () => {
    // A block body is the shape: `named` never gets `Pictures`, so before 4b-i
    // the directory left `requiredDirs` and nothing required the Android XML to
    // exclude it. `Documents` survives, so the roster is non-empty and the
    // vacuity floor is not what answers.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      'ExportDir::Pictures => "Pictures",',
      'ExportDir::Pictures => { "Pictures" }',
    );
    const out = messages(files);
    expect(out).toContain("`ExportDir::Pictures` is declared and this guard could not");
    expect(out).toContain("read its `name()` arm");
    expect(out).not.toContain("came back EMPTY");
    expect([...run(files).requiredDirs]).toEqual(["Documents"]);
  });

  it("fails on an empty-string name() arm, the other half of the same truthiness test", () => {
    // `named.get(variant)` returns `""`, which the pre-4b-i `dir &&` treated
    // exactly as a missing arm. Closing one arm of that test and leaving this
    // one is how the blind spot moves one token over.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      'ExportDir::Pictures => "Pictures",',
      'ExportDir::Pictures => "",',
    );
    const out = messages(files);
    expect(out).toContain("`ExportDir::Pictures`'s `name()` arm is the empty string");
    expect(out).not.toContain("came back EMPTY");
    expect([...run(files).requiredDirs]).toEqual(["Documents"]);
  });

  it("fails when name() has an arm for a variant the enum body does not declare", () => {
    // The reverse direction, and the one the intersection exists for: the two
    // readings of the roster disagree. Neither reading is trusted over the
    // other, so the guard says so rather than picking one.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      'ExportDir::Pictures => "Pictures",',
      'ExportDir::Pictures => "Pictures",\n            ExportDir::Archive => "Archive",',
    );
    const out = messages(files);
    expect(out).toContain("`name()` has an arm for `ExportDir::Archive`");
    expect(out).toContain("enum-body parse did not see as a variant");
    expect(out).not.toContain("came back EMPTY");
    expect([...run(files).requiredDirs]).toEqual(["Documents", "Pictures"]);
  });

  // ── rule 4b-ii: name() and resolve() describe the same directory ─────────
  //
  // Review round 6 measured the uncovered shape as `failures = 0`, and it is
  // the sharpest of the three because both arms are individually valid: the
  // Android rules exclude by NAME and the iOS flag lands on the RESOLVED path,
  // so the XML excludes a directory the exports are not in while the one they
  // are in is excluded by nothing.

  it("fails when name() and resolve() describe different directories", () => {
    // The reviewer's exact case: name()="Documents" with resolve()=picture_dir.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      "ExportDir::Documents => resolver.document_dir(),",
      "ExportDir::Documents => resolver.picture_dir(),",
    );
    const out = messages(files);
    expect(out).toContain('names directory "Documents" but resolves');
    expect(out).toContain("resolver.picture_dir()");
    expect(out).toContain("resolver.document_dir()");
  });

  it("fails on a directory name no pair in RESOLVER_FOR_DIR classifies", () => {
    // Fail-closed on the unknown rather than skipping it, which is the arm that
    // keeps the allowlist from quietly stopping to describe the tree.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE]
      .replace('ExportDir::Pictures => "Pictures",', 'ExportDir::Pictures => "Snapshots",')
      .replace(
        '<exclude domain="external" path="Pictures" />',
        '<exclude domain="external" path="Snapshots" />',
      );
    expect(messages(files)).toContain("which is not in RESOLVER_FOR_DIR");
  });

  it("fails when a variant has no resolve() arm this guard can read", () => {
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      "ExportDir::Pictures => resolver.picture_dir(),",
      "ExportDir::Pictures => picture_dir_for(self),",
    );
    expect(messages(files)).toContain("has no `resolve()` arm this guard can read");
  });

  it("fails by name when resolve() is renamed out from under the guard", () => {
    // The silent-skip direction: with no `fn resolve`, 4b-ii would check
    // nothing, so it says what it could not read instead of reporting ok.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace("fn resolve<", "fn locate<");
    expect(messages(files)).toContain("could not find `fn resolve<");
  });

  it("still fails when the command's destination is not a directory startup excludes", () => {
    // Rule 4c no longer carries its own `!inAll` arm: 4a fails on ANY declared
    // variant absent from `ALL`, so that arm produced two messages for one
    // defect and there was no reachable input where it fired alone. The
    // PROPERTY still has to hold, so this case stays and asserts 4a's message
    // rather than the deleted one.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE]
      .replace("    Documents,\n", "    Documents,\n    Downloads,\n")
      .replace(
        'ExportDir::Documents => "Documents",',
        'ExportDir::Documents => "Documents",\n            ExportDir::Downloads => "Downloads",',
      )
      .replace(
        "EXPORT_DESTINATION: ExportDir = ExportDir::Documents",
        "EXPORT_DESTINATION: ExportDir = ExportDir::Downloads",
      );
    expect(messages(files)).toContain(
      "`ExportDir::Downloads` is declared and is absent from `ExportDir::ALL`",
    );
  });

  it("fails when it cannot tell which directory the command resolves", () => {
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      "pub const EXPORT_DESTINATION: ExportDir = ExportDir::Documents;",
      "",
    );
    expect(messages(files)).toContain("could not find `const EXPORT_DESTINATION");
  });

  it("fails when the resolver stops reading the const the label also reads", () => {
    // The second half of rule 4c, and the reason it is two checks rather than
    // one. The const still says `Documents`, so reading it alone passes; what
    // has broken is that `ensure_export_dir` no longer goes through it, which is
    // the state in which the returned `path` and the `dir` label beside it can
    // name different directories.
    const files = healthyFiles();
    files[RUST_MODULE] = files[RUST_MODULE].replace(
      "ensure(app, EXPORT_DESTINATION)",
      "ensure(app, ExportDir::Documents)",
    );
    expect(messages(files)).toContain(
      "`ensure_export_dir` does not resolve `EXPORT_DESTINATION`",
    );
  });

  it("is not satisfied by an ALL entry that exists only in a comment", () => {
    // The Rust half of the comment-stripping hole the XML side was found by,
    // in a form the rule can actually reach.
    //
    // The fixture this replaces commented out the whole `pub enum ExportDir`
    // block and asserted the "could not find" failure. That passed for an
    // unrelated reason: the enum regex anchors its closing brace at column 0,
    // and the commented block's brace is behind `// `, so the match failed
    // whether or not comments were stripped. Replacing `stripRustComments` with
    // the identity function left that test green.
    //
    // This one is live: with stripping, `ALL` holds only `Documents` and rule 4a
    // names `Downloads` as declared-but-never-walked. Without stripping, `ALL`
    // appears to hold both and nothing fires.
    const files = healthyFiles();
    files[RUST_MODULE] = `pub enum ExportDir {
    Documents,
    Downloads,
}

impl ExportDir {
    pub const ALL: &'static [ExportDir] = &[
        ExportDir::Documents,
        // ExportDir::Downloads,
    ];

    pub const fn name(self) -> &'static str {
        match self {
            ExportDir::Documents => "Documents",
            ExportDir::Downloads => "Downloads",
        }
    }
}

pub const EXPORT_DESTINATION: ExportDir = ExportDir::Documents;

pub fn ensure_export_dir<R>(app: &AppHandle<R>) -> Result<PathBuf, EnsureError> {
    ensure(app, EXPORT_DESTINATION)
}
`;
    expect(messages(files)).toContain(
      "`ExportDir::Downloads` is declared and is absent from `ExportDir::ALL`",
    );
  });

  it("fails when the Rust module is gone", () => {
    const files = healthyFiles();
    delete files[RUST_MODULE];
    expect(messages(files)).toContain("missing, iOS excludes nothing");
  });
});

describe("drift class 5: the chokepoint comes unwired", () => {
  // The five-site ACL LOCKSTEP that used to live here moved to
  // `scripts/check-mobile-plugin-acl.mjs` and `tests/scripts/mobilePluginAcl.test.ts`,
  // widened from this one plugin to all 27 mobile permission directories. It is
  // an availability property; what stays here is the export path's own wiring.

  it("fails when the seam stops calling the chokepoint", () => {
    const files = healthyFiles();
    files[PATH_SEAM] = `export function exportPath(f: string) {\n  return { path: "/tmp/" + f, dir: "Documents", name: f };\n}\n`;
    expect(messages(files)).toContain("does not invoke `plugin:export-dir|export_path`");
  });

  it("fails when the command resolves the directory some other way", () => {
    // The shape that leaves every ACL site satisfied and the exclusion skipped.
    const files = healthyFiles();
    files[PLUGIN_MODULE] = files[PLUGIN_MODULE].replace(
      "backup_exclude::ensure_export_dir(&app)?",
      "app.path().document_dir()?",
    );
    expect(messages(files)).toContain("does not call `backup_exclude::ensure_export_dir`");
  });

  it("is not satisfied by a call to a LONGER name it merely prefixes", () => {
    // C15's defect, four lines below C15's fix, and the existing
    // commented-mention case below could not reach it: comment-stripping
    // removes that fixture before the matcher ever sees it, so that test
    // exercises the stripper. This one renames the live call, which is the
    // only shape that reaches the matcher, and an unanchored `includes` was
    // satisfied by it.
    const files = healthyFiles();
    files[PLUGIN_MODULE] = files[PLUGIN_MODULE].replace(
      "backup_exclude::ensure_export_dir(&app)?",
      "backup_exclude::ensure_export_dir_unchecked(&app)?",
    );
    expect(messages(files)).toContain("does not call `backup_exclude::ensure_export_dir`");
  });

  it("is not satisfied by a plugin body that only MENTIONS the shared call", () => {
    const files = healthyFiles();
    files[PLUGIN_MODULE] = files[PLUGIN_MODULE].replace(
      "    let dir = backup_exclude::ensure_export_dir(&app)?;",
      "    // was: backup_exclude::ensure_export_dir(&app)?\n    let dir = app.path().document_dir()?;",
    );
    expect(messages(files)).toContain("does not call `backup_exclude::ensure_export_dir`");
  });

  it("fails when the plugin module is gone", () => {
    const files = healthyFiles();
    delete files[PLUGIN_MODULE];
    expect(messages(files)).toContain("the export-dir chokepoint has no implementation");
  });

  it("fails when the capability stops granting export-dir:default", () => {
    const files = healthyFiles();
    files[CAPABILITIES] = files[CAPABILITIES].replace(', "export-dir:default"', "");
    expect(messages(files)).toContain('does not grant `"export-dir:default"`');
  });

  it("fails when core:path:default comes back, which is the OTHER direction", () => {
    const files = healthyFiles();
    files[CAPABILITIES] = files[CAPABILITIES].replace(
      '"core:event:default"',
      '"core:path:default", "core:event:default"',
    );
    const out = messages(files);
    expect(out).toContain('grants `"core:path:default"` again');
    expect(out).toContain("name the consumer in review");
  });

  it("fails on a NARROW core:path grant, not only the literal that was dropped", () => {
    // Two narrow grants reconstruct exactly what the wide one gave, and they are
    // what somebody re-adding this would reach for.
    const files = healthyFiles();
    files[CAPABILITIES] = files[CAPABILITIES].replace(
      '"core:event:default"',
      '"core:path:allow-join", "core:path:allow-resolve-directory", "core:event:default"',
    );
    const out = messages(files);
    expect(out).toContain('grants `"core:path:allow-join"` again');
    expect(out).toContain('grants `"core:path:allow-resolve-directory"` again');
  });

  it("fails when the seam invokes a command one character off", () => {
    // `includes` accepted `plugin:export-dir|export_pathh`, a command that does
    // not exist, and the guard said ok. The match is bounded now. Found by
    // enumerating the classes the extracted rule 5 used to catch.
    const files = healthyFiles();
    files[PATH_SEAM] = files[PATH_SEAM].replace(
      "plugin:export-dir|export_path",
      "plugin:export-dir|export_pathh",
    );
    expect(messages(files)).toContain("does not invoke `plugin:export-dir|export_path`");
  });

  it("fails when the command is not in generate_handler!", () => {
    // Did not travel to the ACL guard: that one reads the ACL files, this is the
    // Rust half of the same command being reachable at all.
    const files = healthyFiles();
    files[PLUGIN_MODULE] = files[PLUGIN_MODULE].replace(
      "tauri::generate_handler![export_path]",
      "tauri::generate_handler![]",
    );
    expect(messages(files)).toContain("is not in `generate_handler!`");
  });

  it("fails when the plugin is built under a different namespace", () => {
    const files = healthyFiles();
    files[PLUGIN_MODULE] = files[PLUGIN_MODULE].replace(
      'Builder::<R>::new("export-dir")',
      'Builder::<R>::new("exports")',
    );
    expect(messages(files)).toContain('is not built as `"export-dir"`');
  });

  it("fails when build.rs stops declaring the InlinedPlugin", () => {
    const files = healthyFiles();
    files[BUILD_RS] = files[BUILD_RS].replace('"export-dir",', '"export-directory",');
    const out = messages(files);
    expect(out).toContain('no `InlinedPlugin` declared for "export-dir"');
    expect(out).toContain("__app-acl__");
  });

  it("fails when build.rs declares the plugin without the command", () => {
    // The ACL guard requires every DECLARED command to be allowed; it cannot
    // require a command to be declared, because naming one there is optional in
    // general. For this chokepoint it is not, and this is where that is said.
    const files = healthyFiles();
    files[BUILD_RS] = files[BUILD_RS].replace('&["export_path"]', "&[]");
    expect(messages(files)).toContain("does not list `export_path`");
  });

  it("fails when lib.rs stops registering the plugin", () => {
    const files = healthyFiles();
    files[RUST_SETUP] = files[RUST_SETUP].replace("builder.plugin(plugins::export_dir::init());", "");
    expect(messages(files)).toContain("no `plugins::export_dir::init()` registration");
  });
});

describe("stripTsComments", () => {
  it("removes line and block comments", () => {
    expect(stripTsComments("a(); // b()\nc();")).toBe("a(); \nc();");
    expect(stripTsComments("a(); /* b()\n */ c();")).toBe("a();  c();");
  });

  it("leaves a // inside a string literal alone", () => {
    // Over-stripping here would silently delete real code from the scan.
    expect(stripTsComments('const u = "https://x/documentDir()";')).toContain("documentDir()");
    expect(stripTsComments("const u = 'a // b';")).toContain("a // b");
    expect(stripTsComments("const u = `a // b`;")).toContain("a // b");
  });

  it("handles an escaped quote inside a string", () => {
    expect(stripTsComments('const u = "a\\"b"; // gone')).toBe('const u = "a\\"b"; ');
  });
});

describe("stripRustComments", () => {
  it("removes a commented-out declaration so it cannot read as a live one", () => {
    expect(stripRustComments("// pub enum ExportDir {\npub enum Other {}\n")).not.toContain(
      "ExportDir",
    );
  });

  it("removes doc comments and block comments", () => {
    expect(stripRustComments("/// docs about ExportDir::Downloads\ncode();")).not.toContain(
      "Downloads",
    );
    expect(stripRustComments("a(); /* ExportDir::Downloads */ b();")).not.toContain("Downloads");
  });

  it("leaves a trailing comment's code alone", () => {
    // The rule is anchored to the start of a line, so it never eats code that
    // happens to sit before a comment.
    expect(stripRustComments('let d = "Documents"; // the roster name')).toContain('"Documents"');
  });
});

describe("diskIo().listSeam(), the real walker", () => {
  // The mock `listSeam` in `run()` filters a flat object by prefix, so it is
  // recursive by construction and cannot tell a flat walker from a deep one.
  // N2 was exactly that difference: `check-platform-seam.mjs` exempts the seam
  // directory at EVERY depth, and a flat read here left
  // `mobile/src/platform/fs/files.ts` exempt from that guard and below this
  // one's horizon at the same time. So this case drives the shipped walker over
  // a real directory instead.
  it("reaches a file in a subdirectory of the seam", () => {
    const root = mkdtempSync(join(tmpdir(), "myne-seam-"));
    try {
      mkdirSync(join(root, SEAM_DIR, "fs"), { recursive: true });
      writeFileSync(join(root, SEAM_DIR, "path.ts"), "export {};\n");
      writeFileSync(join(root, SEAM_DIR, "fs", "files.ts"), "export {};\n");
      writeFileSync(join(root, SEAM_DIR, "notes.md"), "not a module\n");
      expect(diskIo(root).listSeam()).toEqual([
        `${SEAM_DIR}/fs/files.ts`,
        `${SEAM_DIR}/path.ts`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns nothing when the seam directory is absent, which rule 0 fails on", () => {
    const root = mkdtempSync(join(tmpdir(), "myne-seam-"));
    try {
      expect(diskIo(root).listSeam()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("stripXmlComments and excludedPaths", () => {
  it("only counts external-domain excludes", () => {
    const xml = `<exclude domain="root" path="Documents" /><exclude domain="external" path="Docs" />`;
    expect([...excludedPaths(xml)]).toEqual(["Docs"]);
  });

  it("normalizes a trailing slash so Documents/ and Documents agree", () => {
    expect([...excludedPaths(`<exclude domain="external" path="Documents/" />`)]).toEqual([
      "Documents",
    ]);
  });

  it("drops comments", () => {
    expect(stripXmlComments("<a/><!-- <b/> --><c/>")).toBe("<a/><c/>");
  });
});
