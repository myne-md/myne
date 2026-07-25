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
import { ImportSourcePicker } from "../../../src/notes/import/ImportSourcePicker";
import {
  IMPORT_SOURCES,
  IMPORT_SOURCE_ORDER,
  allSourceKeywords,
} from "../../../src/notes/import/sourceCatalog";

afterEach(cleanup);

describe("import source catalog", () => {
  it("covers every adapter the epic ships", () => {
    expect([...IMPORT_SOURCE_ORDER].sort()).toEqual([
      "csv",
      "evernote",
      "html",
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

  it("stores i18n KEYS, never resolved strings (a resolved string would freeze the boot language)", () => {
    for (const id of IMPORT_SOURCE_ORDER) {
      const spec = IMPORT_SOURCES[id];
      for (const key of [spec.labelKey, spec.survivesKey, spec.losesKey, spec.pickerTitleKey]) {
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

  it("shows PRE-import fidelity disclosure on every row", () => {
    // The pre-import half of "the fidelity bar per source, and how it is disclosed";
    // the post-import half is the generated import-report note.
    render(<ImportSourcePicker onPick={() => {}} onCancel={() => {}} />);
    expect(screen.getAllByTestId("import.source-survives")).toHaveLength(
      IMPORT_SOURCE_ORDER.length,
    );
    expect(screen.getAllByTestId("import.source-loses")).toHaveLength(
      IMPORT_SOURCE_ORDER.length,
    );
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
