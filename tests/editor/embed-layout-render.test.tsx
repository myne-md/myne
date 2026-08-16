// @vitest-environment jsdom
//
// Rendering the form-C layout segments (myne-md/myne#409 task 4).
//
// The load-bearing rule is the CLAMP, not the numbers: an explicit width is a
// MAXIMUM INTENT, always paired with `max-width: 100%`, because the editor's
// content column is a user preference (`editor_content_width`: narrow 560 /
// normal 680 / wide 820 / full unbounded). Without it a `w=800` embed overflows
// the 680px default column, and a reader who changes that preference breaks the
// layout of notes they already wrote.
//
// The security constraint is asserted here too, because it is the kind that
// rots silently: the value must reach a TYPED CSSOM property setter, never
// `cssText` / `setAttribute("style", …)` / a custom property. A typed setter
// parses against that property's own grammar and rejects wholesale, so a
// note-authored value cannot smuggle a second declaration through.

import { afterEach, describe, expect, it } from "vitest";
import { type CatalogRow } from "../../src/editor/attachments/catalog";
import {
  type Mounted,
  mountEmbeds,
  unmountEmbeds,
} from "./_attachment-mount";

const IMG_ID = "a".repeat(64);
const PDF_ID = "b".repeat(64);

const ROWS: CatalogRow[] = [
  { id: IMG_ID, contentType: "image/png", filename: "photo.png", size: 12 },
  { id: PDF_ID, contentType: "application/pdf", filename: "doc.pdf", size: 34 },
];


let mounted: Mounted | null = null;

/** Mount against the fixed catalog above, record it for teardown, hand back the
 *  host the assertions query. */
async function mount(doc: string): Promise<HTMLElement> {
  mounted = await mountEmbeds(doc, ROWS);
  return mounted.host;
}


/** The embed frame for an image embed. */
function frameOf(host: HTMLElement): HTMLElement {
  const el = host.querySelector(".cm-attachment-frame");
  expect(el, "an embed frame should render").not.toBeNull();
  return el as HTMLElement;
}

function imgOf(host: HTMLElement): HTMLImageElement {
  const el = host.querySelector('[data-testid="attachment-image"]');
  expect(el, "an inline image should render").not.toBeNull();
  return el as HTMLImageElement;
}

/** `![[att:<id>|<alias>]]` for the image row. */
const img = (alias: string) => `![[att:${IMG_ID}|${alias}]]`;

afterEach(() => {
  unmountEmbeds(mounted);
  mounted = null;
});

describe("width is a maximum intent, clamped to the content column", () => {
  it("an explicit pixel width sits on the frame, always with max-width 100%", async () => {
    const frame = frameOf(await mount(img("photo.png|w=800")));
    expect(frame.style.width).toBe("800px");
    // The clamp. Drop it and a 800px embed overflows the 680px default column.
    expect(frame.style.maxWidth).toBe("100%");
  });

  it("a percentage width resolves against the column", async () => {
    const frame = frameOf(await mount(img("photo.png|w=100%")));
    expect(frame.style.width).toBe("100%");
    expect(frame.style.maxWidth).toBe("100%");
  });

  it("no explicit width reproduces the historical 320px cap", async () => {
    const host = await mount(img("photo.png"));
    expect(frameOf(host).style.width).toBe("");
    expect(imgOf(host).style.maxWidth).toBe("320px");
  });

  it("an explicit height applies to the image", async () => {
    expect(imgOf(await mount(img("photo.png|w=300|h=200"))).style.height).toBe("200px");
  });

  it("an invalid width is dropped, so the embed falls back to the default", async () => {
    const host = await mount(img("photo.png|w=abc"));
    expect(frameOf(host).style.width).toBe("");
    expect(imgOf(host).style.maxWidth).toBe("320px");
  });

  it("a width above the ceiling is dropped rather than clamped to the ceiling", async () => {
    expect(frameOf(await mount(img("photo.png|w=99999"))).style.width).toBe("");
  });
});

describe("alignment is applied as a class", () => {
  it.each(["left", "center", "right"] as const)("align=%s adds its classes", async (a) => {
    const frame = frameOf(await mount(img(`photo.png|align=${a}`)));
    expect(frame.classList.contains("cm-attachment-frame-align")).toBe(true);
    expect(frame.classList.contains(`cm-attachment-frame-align-${a}`)).toBe(true);
  });

  it("no alignment adds no alignment class", async () => {
    const frame = frameOf(await mount(img("photo.png")));
    expect(frame.className).not.toContain("cm-attachment-frame-align");
  });

  it("never writes alignment into an inline style string", async () => {
    // The whole point of the class: a note-authored value must not become part
    // of a style string. `align` is a closed set, but the rule is structural.
    const frame = frameOf(await mount(img("photo.png|align=center")));
    expect(frame.style.marginLeft).toBe("");
    expect(frame.getAttribute("style") ?? "").not.toContain("margin");
  });
});

describe("alt text", () => {
  it("author alt replaces the filename on the image", async () => {
    const host = await mount(img("photo.png|alt=A sunset | 2026"));
    expect(imgOf(host).getAttribute("alt")).toBe("A sunset | 2026");
    expect(imgOf(host).getAttribute("aria-label")).toBe("A sunset | 2026");
  });

  it("no authored alt leaves the filename as the accessible name", async () => {
    const host = await mount(img("photo.png"));
    expect(imgOf(host).getAttribute("alt")).toBe("photo.png");
  });

  it("an authored EMPTY alt marks the media decorative", async () => {
    const host = await mount(img("photo.png|alt="));
    expect(imgOf(host).getAttribute("alt")).toBe("");
    expect(imgOf(host).getAttribute("role")).toBe("presentation");
  });

  // ARIA gives a role="img" element presentational children. The name therefore
  // goes on the MEDIA and never on the frame, or the overflow menu and the
  // unreadable-segment marker inside the frame vanish from the accessibility
  // tree on every embed that is not explicitly decorative, which is nearly all
  // of them. The only authoring path for this whole feature lives in that menu.
  it.each(["photo.png", "photo.png|alt=A sunset", "photo.png|alt="])(
    "never puts role=img on the frame, so the menu stays reachable (%s)",
    async (alias) => {
      const host = await mount(img(alias));
      const frame = frameOf(host);
      expect(frame.getAttribute("role")).toBeNull();
      expect(frame.getAttribute("aria-label")).toBeNull();
      expect(host.querySelector('[data-testid="attachment-image.menu-button"]')).not.toBeNull();
    },
  );
});

describe("the tombstone label is the filename, not the raw alias", () => {
  it("splits the alias before labelling a missing attachment", async () => {
    // A segmented embed whose id is absent from the catalog. Before the split
    // this rendered a tombstone labelled `gone.png|w=300|align=center`.
    const missing = "c".repeat(64);
    const host = await mount(`![[att:${missing}|gone.png|w=300|align=center]]`);
    const label = host.querySelector(".cm-attachment-tombstone-label");
    expect(label, "a tombstone should render for a missing id").not.toBeNull();
    expect(label?.textContent).toBe("gone.png");
  });
});

describe("PDF embeds honour the same width and alignment", () => {
  it("applies width and alignment to the PDF frame", async () => {
    const host = await mount(`![[att:${PDF_ID}|doc.pdf|w=640|align=center]]`);
    const frame = frameOf(host);
    expect(frame.style.width).toBe("640px");
    expect(frame.style.maxWidth).toBe("100%");
    expect(frame.classList.contains("cm-attachment-frame-align-center")).toBe(true);
  });
});

describe("the dropped-segment report (markdown-dialect.md §3.9.3)", () => {
  it("marks an embed whose KNOWN key carried an invalid value", async () => {
    const host = await mount(img("photo.png|w=abc"));
    const mark = host.querySelector('[data-testid="attachment-image.unreadable"]');
    expect(mark, "an author-fixable segment should be marked").not.toBeNull();
    // The source text, verbatim, is what §3.9.3 requires be recorded.
    expect(mark?.getAttribute("aria-label")).toContain("w=abc");
    expect((mark as HTMLElement).title).toContain("w=abc");
  });

  it("does NOT mark an unrecognised key, which is version skew rather than an error", async () => {
    // An older client reading a note a newer client wrote. The note is right;
    // marking it would put a warning on every image the newer client styled.
    const host = await mount(img("photo.png|align=center|future=x"));
    expect(host.querySelector('[data-testid="attachment-image.unreadable"]')).toBeNull();
  });

  it("does not mark a clean embed", async () => {
    const host = await mount(img("photo.png|w=300|align=center"));
    expect(host.querySelector('[data-testid="attachment-image.unreadable"]')).toBeNull();
  });

  it("carries the verbatim source into the menu as a report, not an action", async () => {
    const host = await mount(img("photo.png|w=abc"));
    host.querySelector<HTMLElement>('[data-testid="attachment-image.menu-button"]')?.click();
    const detail = document.querySelector<HTMLButtonElement>(
      '[data-testid="attachment-image.unreadable-detail"]',
    );
    expect(detail, "the menu should carry the detail row").not.toBeNull();
    expect(detail?.textContent).toContain("w=abc");
    // A report has nothing to run, so it is disabled rather than clickable.
    expect(detail?.disabled).toBe(true);
  });

  it("still renders the embed correctly at its default size", async () => {
    // The marker says "one segment could not be read", not "this is broken".
    const host = await mount(img("photo.png|w=abc"));
    expect(imgOf(host).style.maxWidth).toBe("320px");
    expect(frameOf(host).style.width).toBe("");
  });

  it("never rewrites the note bytes", async () => {
    const doc = img("photo.png|w=abc|align=diagonal");
    await mount(doc);
    expect(mounted?.view.state.doc.toString()).toBe(doc);
  });
});
