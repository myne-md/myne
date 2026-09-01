// @vitest-environment jsdom
//
// Import source picker + the entry-point generalization (MYND-586).
//
// This suite exists partly to close a standing gap: before this change the importer
// UI carried ZERO `data-testid` attributes, so the whole flow was invisible to both
// the E2E driver and component tests (`src/CLAUDE.md`: "a screen without testids is
// invisible to E2E"). The assertions below therefore address elements by testid, the
// same way the E2E harness will.

import { describe, expect, it, vi } from "vitest";
// `fireEvent`, not `user-event`: the latter is NOT a dependency of this repo, and
// adding one is a security decision here (CLAUDE.md), not a test convenience.
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach } from "vitest";
// The capability seam is mocked rather than driven, because `has()` on the
// desktop implementation is a constant: it answers true for everything, so the
// filter's negative arm is unreachable from the real module and the one test
// that matters could not be written against it.
import * as capabilities from "../../../src/platform/capabilities";
vi.mock("../../../src/platform/capabilities", async (orig) => ({
  ...(await orig<typeof capabilities>()),
  has: vi.fn(() => true),
}));

import { ImportSourcePicker } from "../../../src/notes/import/ImportSourcePicker";
import {
  IMPORT_SOURCES,
  IMPORT_SOURCE_ORDER,
  allSourceKeywords,
  availableSourceOrder,
} from "../../../src/notes/import/sourceCatalog";

afterEach(cleanup);

describe("import source catalog", () => {
  it("covers every adapter the epic ships", () => {
    expect([...IMPORT_SOURCE_ORDER].sort()).toEqual([
      "csv",
      "evernote",
      "html",
      // The sixth source (myne-md/myne#464): the only one whose format is
      // Myne's own, and the only one that reads an ENCRYPTED source.
      "myne",
      "notion",
      "obsidian",
    ]);
  });

  it("marks the single-file sources as file pickers and the trees as directories", () => {
    expect(IMPORT_SOURCES.evernote.pick).toBe("file");
    expect(IMPORT_SOURCES.csv.pick).toBe("file");
    expect(IMPORT_SOURCES.obsidian.pick).toBe("directory");
    expect(IMPORT_SOURCES.notion.pick).toBe("directory");
    expect(IMPORT_SOURCES.html.pick).toBe("directory");
    // Neither: the Myne source picks one of the user's other local vaults from
    // the list the app already keeps, so there is no path to browse to.
    expect(IMPORT_SOURCES.myne.pick).toBe("vault");
  });

  it("gives the single-file sources a native-dialog extension filter", () => {
    expect(IMPORT_SOURCES.evernote.filter?.extensions).toEqual(["enex"]);
    expect(IMPORT_SOURCES.csv.filter?.extensions).toEqual(["csv"]);
  });

  it("carries per-source keywords so ONE entry point stays discoverable by source", () => {
    const kw = allSourceKeywords();
    for (const term of ["obsidian", "notion", "evernote", "html", "csv"]) {
      expect(kw).toContain(term);
    }
  });

  it("omits a source whose capability this platform lacks", () => {
    // The filter, asserted as BEHAVIOUR rather than as a table lookup.
    // Replacing `availableSourceOrder()`'s body with `IMPORT_SOURCE_ORDER`
    // passed every other test in this file, which is what made the filter
    // untested: the picker test reads the constant and the capability test
    // reads the descriptor, and neither runs the function between them.
    const has = vi.mocked(capabilities.has);
    has.mockImplementation((c) => c !== "vaultImport");
    expect(availableSourceOrder()).not.toContain("myne");
    // Every other source is capability-free, so exactly one card leaves.
    expect(availableSourceOrder()).toHaveLength(IMPORT_SOURCE_ORDER.length - 1);
  });

  it("offers it where the capability is present", () => {
    // The other direction, without which the test above passes for a function
    // that returns the empty list.
    vi.mocked(capabilities.has).mockReturnValue(true);
    expect(availableSourceOrder()).toEqual(IMPORT_SOURCE_ORDER);
  });

  it("keeps the keyword list in step with the filtered order", () => {
    vi.mocked(capabilities.has).mockImplementation((c) => c !== "vaultImport");
    expect(allSourceKeywords()).not.toContain("consolidate");
    vi.mocked(capabilities.has).mockReturnValue(true);
    expect(allSourceKeywords()).toContain("consolidate");
  });

  it("gives every source its own brand icon", () => {
    const icons = IMPORT_SOURCE_ORDER.map((id) => IMPORT_SOURCES[id].icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("stores i18n KEYS, never resolved strings (a resolved string would freeze the boot language)", () => {
    for (const id of IMPORT_SOURCE_ORDER) {
      const spec = IMPORT_SOURCES[id];
      for (const key of [
        spec.labelKey,
        spec.shortKey,
        spec.survivesKey,
        spec.losesKey,
        spec.pickerTitleKey,
      ]) {
        expect(key).toMatch(/^notes\.import\.source\./);
      }
    }
  });
});

describe("ImportSourcePicker", () => {
  it("renders one row per source, addressable by testid", () => {
    render(<ImportSourcePicker onPick={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId("import.source-picker")).toBeTruthy();
    const rows = screen.getAllByTestId("import.source-row");
    expect(rows).toHaveLength(IMPORT_SOURCE_ORDER.length);
    // Each row is discriminated by source, the repeated-row convention.
    expect(rows.map((r) => r.getAttribute("data-source"))).toEqual([
      ...IMPORT_SOURCE_ORDER,
    ]);
  });

  it("gives every card a one-line identity, not a wall of disclosure text", () => {
    // The full keeps/loses disclosure lives on the SETUP step now — still before the
    // user commits, but with room to read it. Putting it on the cards made the picker
    // a scrolling wall of text before the five options were even visible.
    render(<ImportSourcePicker onPick={() => {}} onCancel={() => {}} />);
    const shorts = screen.getAllByTestId("import.source-short");
    expect(shorts).toHaveLength(IMPORT_SOURCE_ORDER.length);
    for (const el of shorts) {
      expect((el.textContent ?? "").length).toBeGreaterThan(0);
      // One line, not a paragraph.
      expect((el.textContent ?? "").length).toBeLessThan(60);
    }
    expect(screen.queryAllByTestId("import.source-survives")).toHaveLength(0);
  });

  it("renders sources as text only, with no brand marks (#183)", () => {
    // Reproducing third-party brand marks (even simplified) is a trademark grey
    // area; nominative use of the NAME is fine. So each card is text-only — the
    // localized source name, no brand-derived SVG imagery.
    render(<ImportSourcePicker onPick={() => {}} onCancel={() => {}} />);
    const rows = screen.getAllByTestId("import.source-row");
    expect(rows).toHaveLength(IMPORT_SOURCE_ORDER.length);
    for (const row of rows) {
      expect(row.querySelector("svg")).toBeNull();
      expect((row.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("reports the chosen source", () => {
    const onPick = vi.fn();
    render(<ImportSourcePicker onPick={onPick} onCancel={() => {}} />);
    const notion = screen
      .getAllByTestId("import.source-row")
      .find((r) => r.getAttribute("data-source") === "notion")!;
    fireEvent.click(notion);
    expect(onPick).toHaveBeenCalledWith("notion");
  });

  it("cancels without picking", () => {
    const onCancel = vi.fn();
    render(<ImportSourcePicker onPick={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("import.picker-cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
