// @vitest-environment jsdom
//
// The embed menu's layout rows and the single writer behind them
// (myne-md/myne#409 task 5).
//
// This is the ONLY authoring path for the layout segments. A form-C embed is
// strictly atomic with no source-lift, so the caret never enters it and a user
// cannot type `|w=300` into one. Either these rows write it or nothing does,
// which is why the write path is asserted at the byte level here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type CatalogRow } from "../../src/editor/attachments/catalog";
import {
  type Mounted,
  mountEmbeds,
  openEmbedMenu,
  requireTestId,
  unmountEmbeds,
} from "./_attachment-mount";
import { undo } from "@codemirror/commands";
// The ENGINE path, not a `src/editor/` shim. No shim exists for this module
// and adding one would create a module whose only consumer is this test,
// which is the shape the shim layer exists to avoid: `src/editor/` re-exports
// what `src/` itself consumes. `@myne/editor/attachments/embedLayoutActions`
// resolves through the package's `./*` export map, the same way the sibling
// specs reach `@myne/editor/host`.
import { parseWidthInput } from "@myne/editor/attachments/embedLayoutActions";

const IMG_ID = "a".repeat(64);
const ROWS: CatalogRow[] = [
  { id: IMG_ID, contentType: "image/png", filename: "photo.png", size: 12 },
];


let mounted: Mounted | null = null;

/** Mount against the fixed catalog above, recording it for teardown. */
async function mount(doc: string): Promise<Mounted> {
  mounted = await mountEmbeds(doc, ROWS);
  return mounted;
}

/** Same, with the history extension installed so `undo` has a stack. */
async function mountWithHistory(doc: string): Promise<Mounted> {
  mounted = await mountEmbeds(doc, ROWS, { history: true });
  return mounted;
}


afterEach(() => {
  unmountEmbeds(mounted);
  mounted = null;
  vi.restoreAllMocks();
});

const openMenu = (host: HTMLElement) => openEmbedMenu(host, "attachment-image");

const row = (menu: HTMLElement, testid: string) =>
  requireTestId(menu, `attachment-image.${testid}`);

const embed = (alias: string) => `![[att:${IMG_ID}|${alias}]]`;

describe("the menu offers the layout rows", () => {
  it("carries four size presets, a custom entry, three alignments and the alt editor", async () => {
    const { host } = await mount(embed("photo.png"));
    const menu = openMenu(host);
    for (const id of [
      "size-small",
      "size-medium",
      "size-large",
      "size-full",
      "size-custom",
      "align-left",
      "align-center",
      "align-right",
      "edit-alt",
    ]) {
      row(menu, id);
    }
  });

  it("separates the groups with presentational rules that are not menu items", async () => {
    const { host } = await mount(embed("photo.png"));
    const menu = openMenu(host);
    const seps = menu.querySelectorAll(".cm-attachment-file-card-menusep");
    expect(seps.length).toBe(3);
    for (const s of seps) {
      expect(s.getAttribute("role")).toBe("presentation");
      expect(s.textContent).toBe("");
    }
  });

  it("marks the active size and alignment so the current choice is visible", async () => {
    const { host } = await mount(embed("photo.png|w=400|align=center"));
    const menu = openMenu(host);
    expect(row(menu, "size-medium").getAttribute("aria-checked")).toBe("true");
    expect(row(menu, "size-small").getAttribute("aria-checked")).toBe("false");
    expect(row(menu, "align-center").getAttribute("aria-checked")).toBe("true");
    expect(row(menu, "align-right").getAttribute("aria-checked")).toBe("false");
    // A choice row is a radio within its group, not a plain command.
    expect(row(menu, "size-medium").getAttribute("role")).toBe("menuitemradio");
  });
});

describe("the rows write the segments", () => {
  it("a size preset writes w= into the note in one transaction", async () => {
    const { view, host } = await mount(embed("photo.png"));
    row(openMenu(host), "size-small").click();
    expect(view.state.doc.toString()).toBe(embed("photo.png|w=240"));
  });

  it("full width writes a percentage, not a pixel count", async () => {
    const { view, host } = await mount(embed("photo.png"));
    row(openMenu(host), "size-full").click();
    expect(view.state.doc.toString()).toBe(embed("photo.png|w=100%"));
  });

  it("an alignment writes align=", async () => {
    const { view, host } = await mount(embed("photo.png"));
    row(openMenu(host), "align-center").click();
    expect(view.state.doc.toString()).toBe(embed("photo.png|align=center"));
  });

  it("selecting the ACTIVE preset clears the width, which is how a size is undone", async () => {
    const { view, host } = await mount(embed("photo.png|w=240"));
    row(openMenu(host), "size-small").click();
    expect(view.state.doc.toString()).toBe(embed("photo.png"));
  });

  it("selecting the ACTIVE alignment clears it", async () => {
    const { view, host } = await mount(embed("photo.png|align=right"));
    row(openMenu(host), "align-right").click();
    expect(view.state.doc.toString()).toBe(embed("photo.png"));
  });

  it("switching preset replaces rather than accumulates", async () => {
    const { view, host } = await mount(embed("photo.png|w=100%"));
    row(openMenu(host), "size-large").click();
    expect(view.state.doc.toString()).toBe(embed("photo.png|w=640"));
  });

  it("one undo restores the previous layout exactly", async () => {
    // A real undo, not a manual whole-document replacement: the claim under
    // test is that the write is ONE transaction, and a manual replace succeeds
    // however many transactions the write used.
    const { view, host } = await mountWithHistory(embed("photo.png|w=240"));
    const before = view.state.doc.toString();
    row(openMenu(host), "align-center").click();
    expect(view.state.doc.toString()).not.toBe(before);
    undo(view);
    expect(view.state.doc.toString()).toBe(before);
  });

  it("preserves a pipe-bearing filename when writing a layout", async () => {
    const { view, host } = await mount(embed("re|port.png"));
    row(openMenu(host), "size-small").click();
    expect(view.state.doc.toString()).toBe(embed("re|port.png|w=240"));
  });

  it("writes to THIS embed when the same attachment appears twice in the note", async () => {
    // The write is located by live document position through the syntax tree.
    // A text search for the embed would hit the first occurrence every time.
    const { view, host } = await mount(`${embed("photo.png")}\n\n${embed("photo.png")}`);
    const buttons = host.querySelectorAll<HTMLElement>(
      '[data-testid="attachment-image.menu-button"]',
    );
    expect(buttons.length).toBe(2);
    buttons[1].click();
    const menu = document.querySelector<HTMLElement>('[data-testid="attachment-image.menu"]');
    menu?.querySelector<HTMLElement>('[data-testid="attachment-image.size-small"]')?.click();
    expect(view.state.doc.toString()).toBe(
      `${embed("photo.png")}\n\n${embed("photo.png|w=240")}`,
    );
  });
});

describe("custom size validates through the same closed grammar", () => {
  it.each(["300", "50%", "1", "8192", "100%"])("accepts %s", (raw) => {
    expect(parseWidthInput(raw)).not.toBeNull();
  });

  it.each(["abc", "0", "-5", "8193", "101%", "0%", "", "  ", "300px", "0300"])(
    "refuses %s",
    (raw) => {
      expect(parseWidthInput(raw)).toBeNull();
    },
  );

  it("returns the parsed shape rather than the raw string", () => {
    expect(parseWidthInput(" 300 ")).toEqual({ px: 300, percent: null });
    expect(parseWidthInput("55%")).toEqual({ px: null, percent: 55 });
  });
});
