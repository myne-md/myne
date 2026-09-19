// The attachment-export fallback stem (myne-md/myne#517).
//
// The property under test is narrow and specific: the stem an export falls back
// to when the filename sanitizes away must not be the name the app itself
// invents for an untitled import. `core/src/plugins/attachments/commands.rs`
// builds that as `format!("attachment.{ext}")`, and the fallback here was the
// literal `"attachment"`, so the two met on disk under `overwrite = true`.

import { describe, expect, it } from "vitest";

import { exportFallbackStem } from "../src/lib/exportFallbackStem";

/** What `auto_filename` produces, which is what this must never produce. */
const AUTO_FILENAME_STEM = "attachment";

describe("exportFallbackStem", () => {
  it("never produces the stem the app's own auto-naming produces", () => {
    // The whole finding, as one assertion. Reverting the call site to the
    // literal `"attachment"` is what this is here to catch.
    for (const name of ["..", ".", "...", "", "   ", " .. ", "..pdf", "....tar.gz"]) {
      expect(exportFallbackStem(name)).not.toBe(AUTO_FILENAME_STEM);
      expect(exportFallbackStem(name).startsWith(AUTO_FILENAME_STEM)).toBe(false);
    }
  });

  it("is injective over the names that actually reach it, so two cannot meet", () => {
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
    const stems = names.map(exportFallbackStem);
    expect(new Set(stems).size).toBe(names.length);
  });

  it("is deterministic, so re-exporting overwrites its own earlier copy", () => {
    expect(exportFallbackStem("..pdf")).toBe(exportFallbackStem("..pdf"));
  });

  it("survives the host sanitizer's rules unchanged", () => {
    // `sanitize_filename` flattens separators and strips leading dots, so a
    // stem carrying either would be altered or, worse, reduced away in turn.
    for (const name of ["..", "..pdf", "/", " .. "]) {
      const stem = exportFallbackStem(name);
      expect(stem).not.toMatch(/[/\\]/);
      expect(stem.startsWith(".")).toBe(false);
      expect(stem.trim()).toBe(stem);
      expect(stem.length).toBeGreaterThan(0);
    }
  });

  it("names the empty string rather than dangling", () => {
    expect(exportFallbackStem("")).toBe("myne-export-unnamed");
  });
});
