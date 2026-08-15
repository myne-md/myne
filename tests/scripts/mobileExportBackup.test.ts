// Unit tests for `scripts/check-mobile-export-backup.mjs` (myne-md/myne#491).
//
// The repo rule is that verifying a guard means BREAKING it, and the guard's own
// header records that its XML comment-stripping defect was found that way. That
// break test used to live in a shell transcript, which means the next edit to
// `blockBody` / `excludedPaths` / the TS scan has nothing to prove the guard
// still catches what it caught before. This file is that proof.
//
// `analyse(io)` takes its whole world as an argument, so each defect below is a
// synthetic file set rather than a mutation of the real tree — no `git restore`,
// no risk of a half-restored working copy, and every case runs on every commit.

import { describe, expect, it } from "vitest";

import {
  ANDROID_MANIFEST,
  ANDROID_RULES_LEGACY,
  ANDROID_RULES_MODERN,
  PATH_SEAM,
  ROSTER,
  RUST_MODULE,
  RUST_SETUP,
  TS_ROOT,
  analyse,
  excludedPaths,
  stripTsComments,
  stripXmlComments,
} from "../../scripts/check-mobile-export-backup.mjs";

/** A file set that passes every rule, as the baseline each defect mutates. */
function healthyFiles(): Record<string, string> {
  const files: Record<string, string> = {
    [PATH_SEAM]: `export { documentDir, join } from "@tauri-apps/api/path";\n`,
    [ANDROID_RULES_MODERN]: `<?xml version="1.0" encoding="utf-8"?>
<!-- A comment that mentions <device-transfer> and <cloud-backup> in prose. -->
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="external" path="Documents" />
    </cloud-backup>
    <device-transfer>
        <exclude domain="external" path="Documents" />
    </device-transfer>
</data-extraction-rules>
`,
    [ANDROID_RULES_LEGACY]: `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
    <exclude domain="external" path="Documents" />
</full-backup-content>
`,
    [ANDROID_MANIFEST]: `<manifest>
    <application
        android:dataExtractionRules="@xml/myne_backup_rules"
        android:fullBackupContent="@xml/myne_backup_rules_legacy" />
</manifest>
`,
    [RUST_MODULE]: `pub const EXCLUDED_DIRS: &[&str] = &["Documents"];\n`,
    [RUST_SETUP]: `mod backup_exclude;\nfn setup() { backup_exclude::init(app.handle()); }\n`,
  };
  // One call site per rostered entry, so both directions start satisfied.
  for (const entry of ROSTER) {
    files[entry.file] = `const dest = await ${entry.accessor}();\n`;
  }
  return files;
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
    listTs: (rel: string) =>
      Object.keys(files).filter((f) => f.startsWith(`${rel}/`) && /\.(ts|tsx)$/.test(f)),
    listMergedManifests: () => Object.keys(mergedManifests),
  }) as { failures: string[]; requiredDirs: Set<string>; callSites: number };
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

  it("really does check the roster it claims to, rather than an empty one", () => {
    expect(run(healthyFiles()).callSites).toBe(ROSTER.length);
    expect(ROSTER.length).toBeGreaterThanOrEqual(4);
  });
});

describe("drift class 1: a new flow reaches for an unexcluded sibling accessor", () => {
  it("fails when a file calls downloadDir()", () => {
    const files = healthyFiles();
    files[`${TS_ROOT}/lib/newFlow.ts`] = `const dest = await downloadDir();\n`;
    expect(messages(files)).toContain("calls `downloadDir()`");
    expect(messages(files)).toContain("iCloud / Google Drive");
  });

  it("fails when a rostered accessor is called from an unrostered file", () => {
    const files = healthyFiles();
    files[`${TS_ROOT}/lib/newFlow.ts`] = `const dest = await documentDir();\n`;
    expect(messages(files)).toContain("is not on this guard's roster");
  });

  it("fails at the SEAM when an unexcluded accessor becomes reachable at all", () => {
    // The strongest form of this class: the accessor has no caller yet, so the
    // call-site scan sees nothing, and the guard still refuses.
    const files = healthyFiles();
    files[PATH_SEAM] = `export { documentDir, downloadDir, join } from "@tauri-apps/api/path";\n`;
    expect(messages(files)).toContain("re-exports `downloadDir`");
    expect(messages(files)).toContain("nothing excludes that directory");
  });

  it("fails on an accessor the guard has never classified", () => {
    const files = healthyFiles();
    files[PATH_SEAM] = `export { documentDir, cacheDir, join } from "@tauri-apps/api/path";\n`;
    expect(messages(files)).toContain("re-exports `cacheDir`, which this guard has never classified");
  });

  it("reads through an alias, since the local name is what a consumer calls", () => {
    const files = healthyFiles();
    files[PATH_SEAM] =
      `export { documentDir, downloadDir as dl, join } from "@tauri-apps/api/path";\n`;
    expect(messages(files)).toContain("never classified");
  });

  it("fails when the seam stops re-exporting in a shape the guard can read", () => {
    // Silence would be the wrong answer: a guard that cannot find its input has
    // stopped checking, and that is exactly when it prints ok.
    const files = healthyFiles();
    files[PATH_SEAM] = `import * as path from "@tauri-apps/api/path";\nexport default path;\n`;
    expect(messages(files)).toContain("teach the guard the new shape");
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
    const files = healthyFiles();
    files[ANDROID_RULES_MODERN] = `<?xml version="1.0"?>
<!--
  BOTH blocks are required. <device-transfer> covers phone-to-phone transfer,
  which ignores the <cloud-backup> block entirely.
-->
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="external" path="Documents" />
    </cloud-backup>
    <device-transfer>
    </device-transfer>
</data-extraction-rules>
`;
    expect(messages(files)).toContain("<device-transfer> does not exclude");
  });

  it("is not fooled by an <exclude> that appears only in a comment", () => {
    const files = healthyFiles();
    files[ANDROID_RULES_LEGACY] = `<?xml version="1.0"?>
<full-backup-content>
    <!-- <exclude domain="external" path="Documents" /> was here; see myne#491 -->
</full-backup-content>
`;
    expect(messages(files)).toContain("ignored below API 31");
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
    expect(messages(healthyFiles(), merged)).toContain(
      "the MERGED manifest carries no `android:fullBackupContent`",
    );
  });

  it("passes when the merged manifest agrees", () => {
    const merged = {
      "mobile/src-tauri/gen/android/app/build/intermediates/merged_manifests/x/AndroidManifest.xml":
        healthyFiles()[ANDROID_MANIFEST],
    };
    expect(run(healthyFiles(), merged).failures).toEqual([]);
  });
});

describe("drift class 4: the iOS side stops matching", () => {
  it("fails when backup_exclude::init is dropped from the setup hook", () => {
    const files = healthyFiles();
    files[RUST_SETUP] = `mod backup_exclude;\nfn setup() {}\n`;
    expect(messages(files)).toContain("the shipped-inert shape");
  });

  it("fails when EXCLUDED_DIRS excludes the wrong directory, in BOTH directions", () => {
    const files = healthyFiles();
    files[RUST_MODULE] = `pub const EXCLUDED_DIRS: &[&str] = &["Downloads"];\n`;
    const out = messages(files);
    expect(out).toContain('EXCLUDED_DIRS omits "Documents"');
    expect(out).toContain('EXCLUDED_DIRS carries "Downloads"');
  });

  it("fails when EXCLUDED_DIRS is renamed out from under the guard", () => {
    const files = healthyFiles();
    files[RUST_MODULE] = `pub const BACKUP_EXCLUDED: &[&str] = &["Documents"];\n`;
    expect(messages(files)).toContain("did it get renamed?");
  });
});

describe("the stale-roster direction", () => {
  it("fails when a rostered call site no longer calls the accessor", () => {
    const files = healthyFiles();
    files[ROSTER[0].file] = `// nothing here calls anything\n`;
    expect(messages(files)).toContain("but no such call exists");
  });

  it("is not satisfied by a comment that merely mentions the accessor", () => {
    // The TS half of the comment-stripping defect, and the direction nobody
    // thinks to test: without stripping, this file still counts as a live call
    // site, so the roster goes on asserting a directory the tree stopped
    // writing to and the stale-entry check reports nothing.
    const files = healthyFiles();
    files[ROSTER[0].file] = `// This used to call documentDir() and no longer does.\n`;
    expect(messages(files)).toContain("but no such call exists");
  });

  it("does not fire on a commented mention of an unexcluded accessor", () => {
    // The other side of the same coin: prose about downloadDir() must not fail
    // a commit against a call site that does not exist. The tree's comments
    // discuss exactly these accessors, so this is live, not theoretical.
    const files = healthyFiles();
    files[`${TS_ROOT}/lib/newFlow.ts`] =
      `// Do NOT reach for downloadDir() here; nothing excludes it.\n/** @see pictureDir() */\n`;
    expect(run(files).failures).toEqual([]);
  });
});

describe("the guard fails loudly when it is looking at nothing", () => {
  it("fails once per rostered file when every call site vanishes", () => {
    const files = healthyFiles();
    for (const entry of ROSTER) delete files[entry.file];
    const { failures } = run(files);
    // Every entry named, not a single summary line: the roster's job is to say
    // WHICH site went away.
    expect(failures).toHaveLength(ROSTER.length);
    for (const entry of ROSTER) {
      expect(failures.join("\n")).toContain(entry.file);
    }
  });

  it("fails when the whole TS tree is gone rather than reporting ok", () => {
    // The crashed-before-scanning case. A walk that returns nothing must be a
    // failure, not a smaller walk: that is how a guard reports green on a tree
    // it never opened.
    const files = healthyFiles();
    const out = analyse({
      exists: (rel: string) => rel in files,
      read: (rel: string) => files[rel],
      listTs: () => [],
      listMergedManifests: () => [],
    }) as { failures: string[] };
    expect(out.failures.join("\n")).toContain("no .ts/.tsx files found");
  });

  it("fails when the path seam is gone", () => {
    const files = healthyFiles();
    delete files[PATH_SEAM];
    expect(messages(files)).toContain("looking at the wrong tree");
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
