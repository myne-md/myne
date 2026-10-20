/**
 * `scripts/check-store-publishable.mjs` catches each thing it claims to.
 *
 * `AGENTS.md`: "Verifying a guard means breaking it, not running it. A guard that
 * has never failed is a guard nobody has tested." So every rule below is driven
 * with an input that violates it, and the two rosters are driven from BOTH sides:
 * a screen that mobile cannot reach must fail when a frame names it, and a screen
 * in NEITHER roster must fail too, because that is the case where somebody added a
 * frame without deciding whether the app can reach its screen.
 *
 * The disk half is driven against a directory the test builds, not against the
 * real `fastlane` tree, so it cannot pass by accident on whatever happens to be
 * committed.
 */

import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterAll } from "vitest";
import { check, ownsFile } from "../../scripts/check-store-publishable.mjs";
import { SLOTS, FEATURE_GRAPHIC } from "../../scripts/lib/store-shots/slots.mjs";

const dirs: string[] = [];
function fixtureRoot(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "store-publishable-"));
  dirs.push(dir);
  for (const f of files) writeFileSync(join(dir, f), "not a real png", "utf8");
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const planFor = (dir: string, filenames: string[]) => ({
  slots: [
    {
      slot: SLOTS["android-phone"],
      deviceClass: "phone",
      toggle: "Android",
      frames: filenames.map((filename) => ({ id: filename, filename, out: dir })),
    },
  ],
});

const storyFrame = (id: string, phone: string | null, tablet: string | null = null) => ({
  id,
  screens: { phone, tablet },
});

describe("check-store-publishable", () => {
  it("passes on the real tree, rosters and roots alike", () => {
    expect(check().errors).toEqual([]);
  });

  it("fails by name when a frame names a screen mobile cannot reach", () => {
    const errors = check({ story: [storyFrame("collab", "MB-06")], plan: planFor(fixtureRoot([]), []) }).errors;
    expect(errors.join("\n")).toMatch(
      /the story names screen "MB-06", which a mobile user cannot reach: no mobile caller for personRemoveMember/,
    );
  });

  it("fails by name when a frame names a screen in neither roster", () => {
    const errors = check({ story: [storyFrame("new", "ZZ-99")], plan: planFor(fixtureRoot([]), []) }).errors;
    expect(errors.join("\n")).toMatch(/the story names screen "ZZ-99", which is in neither roster/);
  });

  it("passes when every framed screen is recorded as reachable", () => {
    // The disk half is given a clean fixture too, so this test is about rule 1
    // rather than passing because rule 2 happened to find nothing to say.
    const dir = fixtureRoot(["1.png"]);
    const errors = check({
      story: [storyFrame("notes", "05"), storyFrame("find", "09")],
      plan: planFor(dir, ["1.png"]),
    }).errors;
    expect(errors).toEqual([]);
  });

  it("fails when a screen marked unreachable is still named by a frame", () => {
    // The same screen in the not-reachable roster AND in the story, driven through
    // the roster arm rather than the story arm, so the list cannot be decorative.
    const errors = check({
      story: [storyFrame("collab", "MB-06")],
      reachable: {},
      notReachable: { "MB-06": "kept for the reason" },
      plan: planFor(fixtureRoot([]), []),
    }).errors;
    expect(errors.join("\n")).toMatch(/screen "MB-06" is in NOT_REACHABLE_ON_MOBILE and still named by a frame/);
  });

  it("fails when a publishable root holds a frame no set writes", () => {
    const dir = fixtureRoot(["9.png", "1.png"]);
    const errors = check({ story: [], plan: planFor(dir, ["1.png"]) }).errors;
    expect(errors.join("\n")).toMatch(/9\.png is in a publishable root and no frame of "android-phone" writes it/);
  });

  it("fails when a frame the plan would write is missing", () => {
    const dir = fixtureRoot(["1.png"]);
    const errors = check({ story: [], plan: planFor(dir, ["1.png", "2.png"]) }).errors;
    expect(errors.join("\n")).toMatch(/2\.png is missing from its publishable root/);
  });

  it("fails when a root it was told to scan does not exist", () => {
    const errors = check({ story: [], plan: planFor(join(tmpdir(), "no-such-store-root"), ["1.png"]) }).errors;
    expect(errors.join("\n")).toMatch(/does not exist, so nothing was compared/);
  });

  it("fails a stale frame in a directory no producible set writes", () => {
    // A FIXTURE root, not the real one: `tenInchScreenshots/` is emptied by this same
    // change, so a test pointed at the real tree would assert against an empty
    // directory and could never fail. The first version of this test passed an
    // argument the guard does not read (`extraStaleDirs`) and was green for that
    // reason alone.
    const root = mkdtempSync(join(tmpdir(), "store-stale-"));
    dirs.push(root);
    const stale = join(root, "fastlane/metadata/android/en-US/images/tenInchScreenshots");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "1.png"), "not a real png", "utf8");

    const errors = check({ story: [], plan: { slots: [] }, repoRoot: root }).errors;
    expect(errors.join("\n")).toMatch(/tenInchScreenshots\/1\.png is in tenInchScreenshots\//);
  });

  it("refuses to report ok when no set writes into a publishable root", () => {
    const errors = check({ story: [], plan: { slots: [] } }).errors;
    expect(errors.join("\n")).toMatch(/no set writes into a publishable root, so this check compared nothing/);
  });

  it("fails a plan whose set writes into no directory at all", () => {
    const errors = check({ story: [], plan: planFor(fixtureRoot([]), []) }).errors;
    expect(errors.join("\n")).toMatch(/writes into 0 directories, so the check cannot be two-way/);
  });
});

describe("file ownership", () => {
  it("claims the numbered frames a F-Droid set writes", () => {
    expect(ownsFile(SLOTS["android-phone"], "1.png")).toBe(true);
    expect(ownsFile(SLOTS["android-phone"], "12.png")).toBe(true);
  });

  it("claims the id-named frames an Apple set writes", () => {
    expect(ownsFile(SLOTS["iphone-6.9"], "01-notes.png")).toBe(true);
    expect(ownsFile(SLOTS["iphone-6.9"], "1.png")).toBe(false);
  });

  it("claims exactly its own name for the graphic", () => {
    expect(ownsFile(FEATURE_GRAPHIC, "featureGraphic.png")).toBe(true);
    expect(ownsFile(FEATURE_GRAPHIC, "icon.png")).toBe(false);
  });

  it("does NOT claim the app icon sitting in the same directory", () => {
    // The first run of this guard reported the real `icon.png` as a stale store
    // frame, which is why ownership is explicit rather than "every PNG here".
    expect(ownsFile(FEATURE_GRAPHIC, "icon.png")).toBe(false);
    expect(ownsFile(SLOTS["android-phone"], "icon.png")).toBe(false);
  });
});
