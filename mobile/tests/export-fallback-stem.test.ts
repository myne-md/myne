// The attachment-export fallback stem (myne-md/myne#517).
//
// The property under test is narrow and specific: the stem an export falls back
// to when the filename sanitizes away must not be the name the app itself
// invents for an untitled import. `core/src/plugins/attachments/commands.rs`
// builds that as `format!("attachment.{ext}")`, and the fallback here was the
// literal `"attachment"`, so the two met on disk under `overwrite = true`.

import { describe, expect, it } from "vitest";

import { HEX_INPUT_LIMIT, exportFallbackStem } from "../src/lib/exportFallbackStem";

/** POSIX `NAME_MAX`. A basename past it fails the write with ENAMETOOLONG. */
const NAME_MAX = 255;
/** The longest extension the host sanitizer will re-append: `.` + 10 alnum. */
const MAX_EXTENSION = 11;

/** What `auto_filename` produces, which is what this must never produce. */
const AUTO_FILENAME_STEM = "attachment";

describe("exportFallbackStem", () => {
  it("never produces the stem the app's own auto-naming produces", async () => {
    // The whole finding, as one assertion. Reverting the call site to the
    // literal `"attachment"` is what this is here to catch.
    for (const name of ["..", ".", "...", "", "   ", " .. ", "..pdf", "....tar.gz"]) {
      const stem = await exportFallbackStem(name);
      expect(stem).not.toBe(AUTO_FILENAME_STEM);
      expect(stem.startsWith(AUTO_FILENAME_STEM)).toBe(false);
    }
  });

  it("is injective over the names that actually reach it, so two cannot meet", async () => {
    // Collision-free by construction rather than by improbability: hex of the
    // UTF-8 bytes is injective, so distinct names cannot share a stem. These
    // are the names that sanitize away, which is the set that reaches here.
    //
    // **The last two are the whole point of this case.** Every other name here
    // is five bytes or under, and a `.slice(0, 32)` on the hex shipped for one
    // review round: it left all of those passing while these two collided, both
    // carrying `.pdf`, so the second export overwrote the first. A fixture that
    // cannot reach past the cap cannot hold the defect the cap causes.
    const names = [
      "..",
      ".",
      "...",
      "....",
      "/",
      "\\",
      "./",
      " .. ",
      "   ",
      `${".".repeat(17)}pdf`,
      `${".".repeat(18)}pdf`,
    ];
    const stems = await Promise.all(names.map(exportFallbackStem));
    expect(new Set(stems).size).toBe(names.length);
  });

  it("is deterministic, so re-exporting overwrites its own earlier copy", async () => {
    expect(await exportFallbackStem("..pdf")).toBe(await exportFallbackStem("..pdf"));
    const long = ".".repeat(500);
    expect(await exportFallbackStem(long)).toBe(await exportFallbackStem(long));
  });

  it("survives the host sanitizer's rules unchanged", async () => {
    // `sanitize_filename` flattens separators and strips leading dots, so a
    // stem carrying either would be altered or, worse, reduced away in turn.
    for (const name of ["..", "..pdf", "/", " .. ", ".".repeat(300)]) {
      const stem = await exportFallbackStem(name);
      expect(stem).not.toMatch(/[/\\]/);
      expect(stem.startsWith(".")).toBe(false);
      expect(stem.trim()).toBe(stem);
      expect(stem.length).toBeGreaterThan(0);
    }
  });

  it("names the empty string rather than dangling", async () => {
    expect(await exportFallbackStem("")).toBe("myne-export-unnamed");
  });

  // ── the length bound (review round 6, F3) ────────────────

  it("produces a WRITABLE basename at every length, which the uncapped hex did not", async () => {
    // The regression this bound closes, asserted at the boundary rather than
    // near it. `myne-export-` is 12 bytes and hex DOUBLES its input, so an
    // uncapped stem crosses NAME_MAX at about 120 dots and the write fails with
    // ENAMETOOLONG. `develop` produced "attachment" and exported fine at every
    // length, so this was a path that used to work.
    //
    // Removing the HEX_INPUT_LIMIT branch fails this at 121 and above.
    for (const n of [1, HEX_INPUT_LIMIT, HEX_INPUT_LIMIT + 1, 120, 121, 122, 200, 5000]) {
      const stem = await exportFallbackStem(".".repeat(n));
      expect(stem.length + MAX_EXTENSION).toBeLessThanOrEqual(NAME_MAX);
    }
  });

  it("stays injective ACROSS the bound, where the two encodings meet", async () => {
    // The seam the bound introduces: the short form and the long form must not
    // be able to produce the same stem. The pairs straddle the boundary
    // deliberately. These inputs do not reach the length where the two
    // encodings could collide, so what holds the `h` marker in place is the
    // case below rather than this one.
    const names = [
      "",
      ".".repeat(HEX_INPUT_LIMIT - 1),
      ".".repeat(HEX_INPUT_LIMIT),
      ".".repeat(HEX_INPUT_LIMIT + 1),
      ".".repeat(HEX_INPUT_LIMIT + 2),
      ".".repeat(121),
      ".".repeat(122),
      `${".".repeat(HEX_INPUT_LIMIT)} `,
      `${".".repeat(HEX_INPUT_LIMIT + 1)} `,
    ];
    const stems = await Promise.all(names.map(exportFallbackStem));
    expect(new Set(stems).size).toBe(names.length);
  });

  it("puts the two encodings in disjoint families by first character", async () => {
    expect(await exportFallbackStem("")).toMatch(/^myne-export-u/);
    expect(await exportFallbackStem("..")).toMatch(/^myne-export-[0-9a-f]/);
    expect(await exportFallbackStem(".".repeat(HEX_INPUT_LIMIT + 1))).toMatch(/^myne-export-h/);
  });
});
