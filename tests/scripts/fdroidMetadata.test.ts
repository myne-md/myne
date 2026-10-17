// Unit tests for `scripts/check-fdroid-metadata.mjs`.
//
// The guard's whole claim is that three hand-written artefacts agree by
// arithmetic, and the failure it prevents is invisible to every compiler: the
// store page is simply empty, or three of four architectures are dropped. So
// what is worth pinning here is not "it computes 100001" but every way the
// comparison could pass while the artefacts disagree.
//
// Two halves, deliberately. The rules are driven with injected inputs, and the
// scan itself is driven over a directory this file BUILDS, because the first
// version of a guard like this fails by reading nothing and reporting ok.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  ABI_BY_DIGIT,
  checkMetadata,
  deriveVersionCodes,
  MissingInputError,
  parseRecipeBlocks,
  pngSize,
  scanTreeAt,
} from "../../scripts/check-fdroid-metadata.mjs";

const ROOT: string = fileURLToPath(new URL("../..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "fdroid-metadata-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const VERSION = "0.10.0";

/** The four codes for a version, or a throw: the fixture never guesses. */
function codesOf(version: string = VERSION): number[] {
  return (deriveVersionCodes(version) as { codes: number[] }).codes;
}

/** A minimal PNG: the 8-byte signature, then IHDR at the fixed offset. */
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(26);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** A recipe with one block per ABI, generated rather than copied from the file. */
function recipe(version: string, codes: number[], mutate: (s: string) => string = (s) => s): string {
  let out = "Builds:\n";
  for (const digit of [1, 2, 3, 4]) {
    const abi = (ABI_BY_DIGIT as Record<number, { cargoTarget: string; outDir: string }>)[digit];
    out +=
      `  - versionName: ${version}\n` +
      `    versionCode: ${codes[digit - 1]}\n` +
      `    commit: deadbeef\n` +
      `    output: mobile/src-tauri/gen/android/app/build/outputs/apk/${abi.outDir}/release/app-${abi.outDir}-release-unsigned.apk\n` +
      `    prebuild:\n` +
      `      - sed -i 's|\\.toInt()$|.toInt() * 10 + ${digit}|' mobile/src-tauri/gen/android/app/build.gradle.kts\n` +
      `    build:\n` +
      `      - cargo tauri android build --apk --split-per-abi --target ${abi.cargoTarget}\n`;
  }
  return mutate(out);
}

function scanFor(version = VERSION, overrides: Record<string, unknown> = {}) {
  const codes = codesOf(version);
  return {
    version,
    packageVersion: version,
    recipe: recipe(version, codes),
    changelogs: codes.map((c) => `${c}.txt`),
    texts: {
      title: "Myne",
      shortDescription: "Encrypted, local-first markdown notes",
      fullDescription: "A long description.",
      ...Object.fromEntries(codes.map((c) => [`changelogs/${c}.txt`, "What's new."])),
    },
    icon: png(512, 512),
    phoneScreenshots: 5,
    ...overrides,
  };
}

const errorsOf = (scan: Parameters<typeof checkMetadata>[0]): string => checkMetadata(scan).errors.join("\n");

describe("deriveVersionCodes", () => {
  it("applies Tauri's own formula and the recipe's per-ABI multiplier", () => {
    expect(deriveVersionCodes("0.10.0")).toEqual({
      base: 10000,
      codes: [100001, 100002, 100003, 100004],
    });
    // The same formula the tree was measured against: a shipped 0.9.0 carries
    // versionCode 9000, which is what makes 10000 the right base for 0.10.0.
    expect((deriveVersionCodes("0.9.0") as { base: number }).base).toBe(9000);
  });

  it("refuses a version it cannot derive from, rather than guessing", () => {
    for (const bad of ["0.10", "v0.10.0", "0.10.0-beta.1", ""]) {
      expect(deriveVersionCodes(bad).error).toBeTruthy();
    }
    expect((deriveVersionCodes(undefined as unknown as string).error as string)).toContain("not a string");
  });

  it("refuses a version whose derived code passes Google Play's ceiling", () => {
    // 210.0.0 -> base 210000000 -> the four codes land above 2.1e9.
    expect(deriveVersionCodes("210.0.0").error).toContain("2100000000");
  });
});

describe("checkMetadata, over a valid scan", () => {
  it("passes", () => {
    expect(checkMetadata(scanFor()).errors).toEqual([]);
  });

  it("warns, but does not fail, on a placeholder build commit", () => {
    const scan = scanFor(VERSION, { recipe: recipe(VERSION, codesOf(VERSION), (s) => s.replace("deadbeef", "REPLACE_WITH_RELEASE_COMMIT")) });
    const { errors, warnings } = checkMetadata(scan);
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toContain("placeholder");
  });
});

describe("the version is the join, so a bump without the renames must fail", () => {
  it("names every stale artefact when only the version moves", () => {
    // The realistic mistake: bump `tauri.conf.json` and nothing else.
    const moved = scanFor("0.11.0", {
      recipe: recipe(VERSION, codesOf(VERSION)),
      changelogs: codesOf(VERSION).map((c: number) => `${c}.txt`),
    });
    const errors = errorsOf(moved);
    expect(errors).toMatch(/versionName is "0\.10\.0", tauri\.conf\.json says "0\.11\.0"/);
    expect(errors).toMatch(/changelogs\/110001\.txt is missing/);
    expect(errors).toMatch(/changelogs\/100001\.txt is orphaned/);
    expect(errors).toMatch(/recipe versionCode 100001 is not one of 110001/);
  });

  it("fails on an orphaned changelog even when every expected one is present", () => {
    const scan = scanFor(VERSION, {
      changelogs: [...codesOf(VERSION).map((c: number) => `${c}.txt`), "9004.txt"],
    });
    expect(errorsOf(scan)).toMatch(/changelogs\/9004\.txt is orphaned/);
  });
});

describe("the recipe's internal arithmetic", () => {
  it("fails when a block's declared code and its sed digit disagree", () => {
    const codes = codesOf(VERSION);
    const scan = scanFor(VERSION, {
      recipe: recipe(VERSION, [codes[0], codes[1], codes[2], codes[3]], (s) =>
        s.replace(`versionCode: ${codes[1]}`, `versionCode: ${codes[2]}`),
      ),
    });
    expect(errorsOf(scan)).toMatch(/versionCode 100003, digit 2 over base 10000 gives 100002/);
  });

  it("fails when a digit is paired with the wrong cargo target", () => {
    const scan = scanFor(VERSION, {
      recipe: recipe(VERSION, codesOf(VERSION), (s) =>
        s.replace("--target aarch64", "--target armv7"),
      ),
    });
    expect(errorsOf(scan)).toMatch(/builds --target armv7, digit 2 means aarch64/);
  });

  it("fails when an expected changelog is absent, and when the recipe is empty", () => {
    const codes = codesOf(VERSION);
    const scan = scanFor(VERSION, { changelogs: codes.slice(0, 3).map((c: number) => `${c}.txt`) });
    expect(errorsOf(scan)).toMatch(/changelogs\/100004\.txt is missing/);
    // The other direction, so neither can be satisfied by the other's fixture:
    // an empty recipe must fail by name rather than passing over zero blocks.
    expect(errorsOf({ ...scan, recipe: "Builds: []\n" })).toMatch(/zero build blocks/);
  });
});

describe("F-Droid's own limits", () => {
  it("fails a short description over 80 characters", () => {
    const scan = scanFor(VERSION, { texts: { ...scanFor().texts, shortDescription: "x".repeat(81) } });
    expect(errorsOf(scan)).toMatch(/short_description\.txt is 81 chars, the limit is 80/);
  });

  it("fails a short description ending in a full stop", () => {
    const scan = scanFor(VERSION, { texts: { ...scanFor().texts, shortDescription: "Ends with one." } });
    expect(errorsOf(scan)).toMatch(/ends with a full stop/);
  });

  it("fails an over-long title, description and changelog", () => {
    const texts = scanFor().texts as Record<string, string>;
    expect(errorsOf(scanFor(VERSION, { texts: { ...texts, title: "x".repeat(51) } }))).toMatch(
      /title\.txt is 51 chars, the limit is 50/,
    );
    expect(errorsOf(scanFor(VERSION, { texts: { ...texts, fullDescription: "x".repeat(4001) } }))).toMatch(
      /full_description\.txt is 4001 chars, the limit is 4000/,
    );
    const code = (codesOf(VERSION))[0];
    expect(
      errorsOf(scanFor(VERSION, { texts: { ...texts, [`changelogs/${code}.txt`]: "x".repeat(501) } })),
    ).toMatch(/changelogs\/100001\.txt is 501 chars, the limit is 500/);
  });
});

describe("graphics, because a missing icon is a blank Latest tab", () => {
  it("fails on a missing icon and on a non-PNG icon", () => {
    expect(errorsOf(scanFor(VERSION, { icon: null }))).toMatch(/images\/icon\.png is missing/);
    expect(errorsOf(scanFor(VERSION, { icon: Buffer.from("not a png at all, honestly") }))).toMatch(
      /not a PNG/,
    );
    expect(errorsOf(scanFor(VERSION, { phoneScreenshots: 0 }))).toMatch(/holds no screenshots/);
  });

  it("warns on a non-square icon instead of failing", () => {
    const { errors, warnings } = checkMetadata(scanFor(VERSION, { icon: png(512, 256) }));
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/512x256, not square/);
  });

  it("reads PNG dimensions without a dependency", () => {
    expect(pngSize(png(1320, 2868))).toEqual({ width: 1320, height: 2868 });
    expect(pngSize(Buffer.alloc(4))).toBeNull();
  });

  it("warns about a directory F-Droid would ignore in silence", () => {
    // The typo class: `phoneScreenshot/` next to `phoneScreenshots/` loses every
    // graphic on the store page and nothing anywhere says a word.
    const { errors, warnings } = checkMetadata(
      scanFor(VERSION, { imageEntries: ["icon.png", "phoneScreenshot"] }),
    );
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/images\/phoneScreenshot is not a name F-Droid reads/);
  });
});

describe("parseRecipeBlocks", () => {
  it("returns nulls rather than throwing when the shape moves", () => {
    expect(parseRecipeBlocks("nothing here")).toEqual([]);
    const [b] = parseRecipeBlocks("  - versionName: 1.0.0\n    commit: abc\n");
    expect(b).toEqual({
      versionName: "1.0.0",
      versionCode: null,
      digit: null,
      cargoTarget: null,
      output: null,
    });
  });
});

describe("the scan, over a directory this test builds", () => {
  function buildTree(root: string, opts: { version?: string; codes?: number[] } = {}) {
    const version = opts.version ?? VERSION;
    const codes = opts.codes ?? (codesOf(version));
    mkdirSync(join(root, "mobile", "src-tauri"), { recursive: true });
    mkdirSync(join(root, "mobile", "fdroid"), { recursive: true });
    mkdirSync(join(root, "fastlane", "metadata", "android", "en-US", "changelogs"), { recursive: true });
    mkdirSync(join(root, "fastlane", "metadata", "android", "en-US", "images", "phoneScreenshots"), {
      recursive: true,
    });
    writeFileSync(join(root, "mobile", "src-tauri", "tauri.conf.json"), JSON.stringify({ version }));
    writeFileSync(join(root, "mobile", "package.json"), JSON.stringify({ version }));
    writeFileSync(join(root, "mobile", "fdroid", "md.myne.mobile.yml"), recipe(version, codes));
    const meta = join(root, "fastlane", "metadata", "android", "en-US");
    writeFileSync(join(meta, "title.txt"), "Myne\n");
    writeFileSync(join(meta, "short_description.txt"), "Encrypted notes\n");
    writeFileSync(join(meta, "full_description.txt"), "Body.\n");
    for (const c of codes) writeFileSync(join(meta, "changelogs", `${c}.txt`), "What is new.\n");
    writeFileSync(join(meta, "images", "icon.png"), png(512, 512));
    writeFileSync(join(meta, "images", "phoneScreenshots", "1.png"), png(1320, 2868));
  }

  function freshTree(name: string, opts: { version?: string; codes?: number[] } = {}) {
    const root = join(scratch, name);
    buildTree(root, opts);
    return root;
  }

  it("passes over a tree it built itself", () => {
    expect(checkMetadata(scanTreeAt(freshTree("good"))).errors).toEqual([]);
  });

  it("reads the real tree green, which is the half injection cannot cover", () => {
    const { errors, warnings } = checkMetadata(scanTreeAt(ROOT));
    expect(errors).toEqual([]);
    // The one warning the real tree is allowed to carry while the recipe is a
    // draft. If a second one appears, this fails rather than being noticed by
    // nobody six months from now.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("placeholder");
  });

  it("throws by name when an input is absent, rather than reporting ok", () => {
    const root = freshTree("missing");
    rmSync(join(root, "fastlane"), { recursive: true, force: true });
    expect(() => scanTreeAt(root)).toThrow(MissingInputError);
    expect(() => scanTreeAt(root)).toThrow(/fastlane/);
  });

  it("sees a defect injected into the built tree", () => {
    const root = freshTree("drifted");
    const file = join(root, "fastlane", "metadata", "android", "en-US", "changelogs", "100004.txt");
    rmSync(file);
    expect(checkMetadata(scanTreeAt(root)).errors.join("\n")).toMatch(/changelogs\/100004\.txt is missing/);
  });
});

describe("the committed artefacts, read from disk", () => {
  it("keeps the short description inside F-Droid's limit as committed", () => {
    // Read through the tree rather than restating the string, so this cannot
    // pass against a copy of a value the file no longer holds.
    const short = readFileSync(
      join(ROOT, "fastlane", "metadata", "android", "en-US", "short_description.txt"),
      "utf8",
    ).trim();
    expect(short.length).toBeLessThanOrEqual(80);
    expect(short.endsWith(".")).toBe(false);
  });
});
