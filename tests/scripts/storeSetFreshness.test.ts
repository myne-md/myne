/**
 * `scripts/check-store-set-freshness.mjs`, every arm driven with an input that
 * violates it.
 *
 * Two halves, and the second is the one the repository's own notes say nobody
 * tests: the READING half warns, and the WRITING half (`--record`) is the tool
 * that can quietly license everything it found. `AGENTS.md`: "A guard that WRITES
 * its own record has a second half nobody verifies: the seeding path."
 *
 * So `appendEntries` is driven with a record that already holds an entry for a set
 * whose hash has NOT moved (must append nothing) and with one whose hash HAS moved
 * (must append exactly one, and must leave the earlier entry intact).
 */

import { describe, expect, it } from "vitest";
import { freshnessReport, appendEntries, pngSize } from "../../scripts/check-store-set-freshness.mjs";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_GRAPHIC, SLOTS } from "../../scripts/lib/store-shots/slots.mjs";

const fakeHash = (frames: Record<string, string>) => ({
  frames,
  hash: `h-${JSON.stringify(frames)}`.slice(0, 16),
  missing: 0,
});

describe("the reading half", () => {
  it("warns when a committed set has no entry in the record", () => {
    const { warnings } = freshnessReport({ existsFor: () => true,
      record: { entries: [] },
      hashOf: () => fakeHash({ "1.png": "a" }),
    });
    expect(warnings.join("\n")).toMatch(/set "iphone-6\.9" is committed and has no entry in the record; run --record/);
  });

  it("warns when the tree no longer matches the record", () => {
    const { warnings } = freshnessReport({ existsFor: () => true,
      record: { entries: [{ set: "iphone-6.9", hash: "recorded", frames: {}, at: "2026-10-01" }] },
      hashOf: () => fakeHash({ "01-notes.png": "moved" }),
    });
    expect(warnings.join("\n")).toMatch(/set "iphone-6\.9" no longer matches the record \(recorded recorded/);
  });

  it("names the FRAMES that changed when the tree no longer matches the record", () => {
    // This is the arm a maintainer meets in the hook, so it names what moved rather
    // than only the set: "set X changed" sends them to diff eight PNGs by eye.
    const { warnings } = freshnessReport({ existsFor: () => true,
      record: {
        entries: [
          {
            set: "iphone-6.9",
            hash: "old",
            frames: { "01-notes.png": "same", "02-markdown.png": "old" },
            at: "2026-10-01",
          },
        ],
      },
      hashOf: () => fakeHash({ "01-notes.png": "same", "02-markdown.png": "new" }),
    });
    expect(warnings.join("\n")).toMatch(/Frames that changed: 02-markdown\.png\./);
  });

  it("names the one frame a set gained as changed, not only a frame that moved", () => {
    const { warnings } = freshnessReport({ existsFor: () => true,
      record: {
        entries: [{ set: "iphone-6.9", hash: "old", frames: { "01-notes.png": "a" }, at: "2026-10-01" }],
      },
      hashOf: () => fakeHash({ "01-notes.png": "a", "02-markdown.png": "new" }),
    });
    expect(warnings.join("\n")).toMatch(/Frames that changed: 02-markdown\.png\./);
  });

  it("treats a COMMITTED set that moved as a failure, not a warning", () => {
    // The committed roots are the bytes a store receives, and comparing them
    // against the record is bytes against bytes: no browser, no GPU, no scale
    // factor. So the warning-only reason (a re-render reddens on a browser bump)
    // does not reach this arm, and a published PNG edited without `--record` is
    // the one drift no other guard can see.
    const report = freshnessReport({
      existsFor: () => true,
      record: { entries: [{ set: "android-phone", hash: "recorded", frames: { "1.png": "a" }, at: "x" }] },
      hashOf: (slot: any) =>
        slot.id === "android-phone"
          ? fakeHash({ "1.png": "edited" })
          : fakeHash({ "1.png": "a" }),
    });
    expect(report.warnings.join("\n")).not.toMatch(/android-phone no longer matches/);
    expect(report.failures.join("\n")).toMatch(/set "android-phone" no longer matches the record/);
  });

  it("skips a genesis-less staging root instead of warning on a correct tree", () => {
    const report = freshnessReport({
      existsFor: (slot: any) => slot.root !== "staged",
      record: { entries: [] },
      hashOf: () => fakeHash({ "1.png": "a" }),
    });
    expect(report.skipped.map((s: any) => s.id).sort()).toEqual(["ipad-13", "iphone-6.9"]);
    expect(report.warnings.join("\n")).not.toMatch(/iphone-6\.9|ipad-13/);
  });

  it("warns when featureGraphic.png is the wrong size", () => {
    // The graphics size arm: `pngSize` is driven above, but this branch (a real
    // file at the wrong dimensions) had no test. A temp path is the seam so the
    // committed 1024x500 file is never touched.
    const head = Buffer.alloc(24);
    head.writeUInt32BE(0x89504e47, 0);
    head.writeUInt32BE(0x0d0a1a0a, 4);
    head.write("IHDR", 12, "ascii");
    head.writeUInt32BE(800, 16);
    head.writeUInt32BE(400, 20);
    const dir = mkdtempSync(join(tmpdir(), "store-graphic-"));
    const path = join(dir, "featureGraphic.png");
    writeFileSync(path, head);
    try {
      const { warnings } = freshnessReport({ existsFor: () => true,
        record: { entries: [] },
        hashOf: () => fakeHash({ "1.png": "a" }),
        graphicPath: path,
      });
      expect(warnings.join("\n")).toMatch(/featureGraphic\.png measures 800x400, not 1024x500/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns about a set that is incomplete against the plan", () => {
    const { warnings } = freshnessReport({ existsFor: () => true,
      record: { entries: [] },
      hashOf: () => ({ ...fakeHash({ "1.png": "a" }), missing: 7 }),
    });
    expect(warnings.join("\n")).toMatch(/set "iphone-6\.9" is missing 7 frame\(s\) the plan would write/);
  });

  it("names the FRAMES that moved when a re-render is compared", () => {
    const { warnings } = freshnessReport({ existsFor: () => true,
      record: { entries: [{ set: "iphone-6.9", hash: fakeHash({ "01-notes.png": "a" }).hash, frames: {}, at: "x" }] },
      hashOf: (_slot: unknown, dir: string | null) =>
        dir ? fakeHash({ "01-notes.png": "different" }) : fakeHash({ "01-notes.png": "a" }),
      renderDirFor: () => "/tmp/whatever",
    });
    expect(warnings.join("\n")).toMatch(/has drifted from the app; frames that moved: 01-notes\.png/);
  });

  it("reports no DRIFT when the re-render is identical", () => {
    const same = fakeHash({ "01-notes.png": "a" });
    const { warnings } = freshnessReport({ existsFor: () => true,
      record: { entries: [{ set: "iphone-6.9", hash: same.hash, frames: {}, at: "x" }] },
      hashOf: () => same,
      renderDirFor: () => "/tmp/whatever",
    });
    // This function walks EVERY set, so a fixture that records one set legitimately
    // sees the others as new. What this test is about is the drift arm.
    expect(warnings.filter((w: string) => w.includes("drifted"))).toEqual([]);
  });

  it("never throws, because it is a warning and must exit 0", () => {
    expect(() => freshnessReport({ existsFor: () => true, record: { entries: [] } })).not.toThrow();
  });
});

describe("the writing half", () => {
  it("adds no SECOND entry for a set whose hash has not moved", () => {
    const record = {
      entries: [{ set: "iphone-6.9", hash: "__MISSING__", frames: {}, at: "x" }],
    };
    // Every set looks unchanged to the injected hasher, so the sets with no entry
    // at all are appended (correctly) and the one WITH a matching entry is not.
    const { record: next } = appendEntries(record, () => ({ frames: {}, hash: "__MISSING__", missing: 0 }));
    expect(next.entries.filter((e: { set: string }) => e.set === "iphone-6.9")).toHaveLength(1);
  });

  it("appends one entry when a set moved, and keeps the earlier entry intact", () => {
    const earlier = { set: "iphone-6.9", hash: "old", frames: { "1.png": "old" }, at: "2026-10-01" };
    const { appended, record: next } = appendEntries({ entries: [earlier] }, () =>
      fakeHash({ "1.png": "new" }),
    );
    expect(appended).toBeGreaterThan(0);
    expect(next.entries[0]).toEqual(earlier);
    expect(next.entries.length).toBeGreaterThan(1);
  });

  it("never shortens the record, whatever the input", () => {
    const entries = [
      { set: "iphone-6.9", hash: "a", frames: {}, at: "x" },
      { set: "ipad-13", hash: "b", frames: {}, at: "y" },
    ];
    const { record } = appendEntries({ entries }, () => fakeHash({ "1.png": "z" }));
    expect(record.entries.length).toBeGreaterThanOrEqual(entries.length);
    expect(record.entries.slice(0, 2)).toEqual(entries);
  });
});

describe("pngSize", () => {
  /**
   * Built here, never read off disk.
   *
   * The first version read `mobile/store/staged/iphone-6.9/01-notes.png`, which is
   * GITIGNORED, so on a fresh clone and in CI four of this file's twelve tests
   * failed, one with ENOENT. A test that depends on an artefact no clone has is a
   * test that is red for everybody but its author, and it is exactly the shape
   * `AGENTS.md` warns about when it says a fixture has to be able to hold the state
   * under test.
   */
  const pngWithSize = (width: number, height: number) => {
    const head = Buffer.alloc(24);
    head.writeUInt32BE(0x89504e47, 0);
    head.writeUInt32BE(0x0d0a1a0a, 4);
    head.write("IHDR", 12, "ascii");
    head.writeUInt32BE(width, 16);
    head.writeUInt32BE(height, 20);
    return head;
  };

  it("reads dimensions out of a PNG header", () => {
    expect(pngSize(pngWithSize(1320, 2868))).toEqual({ width: 1320, height: 2868 });
    expect(pngSize(pngWithSize(1024, 500))).toEqual({ width: 1024, height: 500 });
  });

  it("returns null for something that is not a PNG", () => {
    expect(pngSize(Buffer.from("not a png at all, definitely not"))).toBeNull();
    expect(pngSize(Buffer.alloc(4))).toBeNull();
  });

  it("agrees with the slot table it is meant to police", () => {
    // The one committed image this feature writes, so the assertion is about a real
    // artefact rather than a hand-built buffer, and about the file whose absence
    // F-Droid would not have complained about.
    const committed = "fastlane/metadata/android/en-US/images/featureGraphic.png";
    expect(pngSize(readFileSync(committed))).toEqual({
      width: FEATURE_GRAPHIC.width,
      height: FEATURE_GRAPHIC.height,
    });
    expect(SLOTS["android-phone"].width).toBe(1080);
  });
});
