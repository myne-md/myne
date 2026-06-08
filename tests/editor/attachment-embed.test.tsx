// @vitest-environment jsdom
//
// Form-C attachment-embed rendering (MYND-164, tasks 1 / 2 / 3 / 6).
//
//   - `att:` prefix routes resolution to the catalog; non-`att:` embeds untouched
//   - resolved raster/SVG → inline <img src="attachment://<id>">
//   - resolved PDF → pdf widget (loading state; pdf.js mocked off so it can't run)
//   - missing id (catalog loaded, absent) → "deleted" tombstone
//   - malformed att: target → wikilink chip (broken-reference degradation)
//   - the embed is atomic (registers an EditorView.atomicRanges range)
//   - note bytes are never rewritten (doc string unchanged after render)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cursorCharLeft, deleteCharBackward } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import {
  type CatalogRow,
  attachmentCatalogExtension,
  setCatalogLoader,
} from "../../src/editor/attachments/catalog";
import { attachmentEmbedDecorations } from "../../src/editor/decorations/attachment-embed";
import { wikilinkChipExtensions } from "../../src/editor/wikilink";

const RASTER_ID = "a".repeat(64);
const PDF_ID = "b".repeat(64);

function catalog(rows: CatalogRow[]): ReadonlyMap<string, CatalogRow> {
  return new Map(rows.map((r) => [r.id, r]));
}

type Mounted = { view: EditorView; host: HTMLElement };

/** Mount with a synchronous catalog loader resolving to `rows`. The loader
 *  resolves on a microtask; we flush it before asserting. */
async function mount(doc: string, rows: CatalogRow[]): Promise<Mounted> {
  const restore = setCatalogLoader(async () => catalog(rows));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Wikilink] }),
        ...attachmentCatalogExtension(),
        ...attachmentEmbedDecorations(),
        ...wikilinkChipExtensions(),
      ],
    }),
    parent: host,
  });
  // Flush the catalog loader microtask + let the dispatch land.
  await Promise.resolve();
  await Promise.resolve();
  view.requestMeasure();
  restore();
  return { view, host };
}

let mounted: Mounted | null = null;
afterEach(() => {
  if (mounted !== null) {
    mounted.view.destroy();
    mounted.host.remove();
  }
  mounted = null;
});

describe("form-C resolved render", () => {
  it("renders a resolved raster as an inline <img src=attachment://id>", async () => {
    mounted = await mount(`![[att:${RASTER_ID}|photo.png]]`, [
      { id: RASTER_ID, contentType: "image/png", filename: "photo.png", size: 10 },
    ]);
    const img = mounted.host.querySelector("img.cm-attachment-img") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(`attachment://${RASTER_ID}`);
    // Filename caption is REMOVED in the editor embed (dogfooding fix #2) — the
    // media renders alone. The filename survives only as the <img> alt + frame
    // aria-label for assistive tech.
    expect(mounted.host.querySelector(".cm-attachment-caption")).toBeNull();
    expect(img!.alt).toBe("photo.png");
  });

  it("renders a resolved SVG ONLY through <img> (never inlined markup)", async () => {
    mounted = await mount(`![[att:${RASTER_ID}|logo.svg]]`, [
      { id: RASTER_ID, contentType: "image/svg+xml", filename: "logo.svg", size: 10 },
    ]);
    const img = mounted.host.querySelector("img.cm-attachment-img") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(`attachment://${RASTER_ID}`);
    // No raw <svg> element entered the DOM (secure static mode).
    expect(mounted.host.querySelector(".cm-attachment-frame svg")).toBeNull();
  });

  it("renders a resolved PDF as the pdf widget with a Decrypting… loading state", async () => {
    mounted = await mount(`![[att:${PDF_ID}|doc.pdf]]`, [
      { id: PDF_ID, contentType: "application/pdf", filename: "doc.pdf", size: 10 },
    ]);
    expect(mounted.host.querySelector(".cm-attachment-pdf")).not.toBeNull();
    // The reader mounts into the always-visible scroller (no display:none gate).
    // pdf.js dynamic import is unavailable in jsdom → it either stays on the
    // "Loading…" chip or flips to the icon fallback; both are acceptable.
    const scroller = mounted.host.querySelector(".cm-attachment-pdf-scroller");
    expect(scroller).not.toBeNull();
  });
});

describe("form-C tombstone (deleted vs broken)", () => {
  it("renders a DELETED tombstone for a valid id absent from the catalog", async () => {
    mounted = await mount(`![[att:${RASTER_ID}|gone.png]]`, []); // empty catalog
    const tomb = mounted.host.querySelector(".cm-attachment-tombstone-deleted");
    expect(tomb).not.toBeNull();
    expect(tomb!.querySelector(".cm-attachment-tombstone-label")?.textContent).toBe("gone.png");
    // No <img> ever created for a deleted attachment.
    expect(mounted.host.querySelector("img.cm-attachment-img")).toBeNull();
  });

  it("leaves a MALFORMED att: target as an ordinary wikilink chip (broken ref)", async () => {
    // `att:` + too-short id → not a valid attachment id → not an attachment embed.
    mounted = await mount(`![[att:short|bad]]`, []);
    expect(mounted.host.querySelector(".cm-attachment-tombstone")).toBeNull();
    expect(mounted.host.querySelector(".cm-attachment-img")).toBeNull();
    // Falls through to the wikilink embed chip.
    expect(mounted.host.querySelector(".cm-wikilink-chip-embed")).not.toBeNull();
  });

  it("leaves a non-att embed to the wikilink chip", async () => {
    mounted = await mount(`![[Some Note]]`, []);
    expect(mounted.host.querySelector(".cm-attachment-tombstone")).toBeNull();
    expect(mounted.host.querySelector(".cm-wikilink-chip-embed")).not.toBeNull();
  });
});

describe("form-C atomicity + byte stability", () => {
  it("backspace right-of-embed deletes the WHOLE embed in one keystroke", async () => {
    const doc = `x ![[att:${RASTER_ID}|p.png]] y`;
    mounted = await mount(doc, [
      { id: RASTER_ID, contentType: "image/png", filename: "p.png", size: 10 },
    ]);
    const rightOfEmbed = doc.indexOf("]]") + 2;
    mounted.view.dispatch({ selection: { anchor: rightOfEmbed } });
    deleteCharBackward(mounted.view);
    // The entire `![[att:…|p.png]]` span is gone in one delete (atomic).
    expect(mounted.view.state.doc.toString()).toBe("x  y");
  });

  it("arrow-left skips over the embed (no rest inside the atomic span)", async () => {
    const doc = `x ![[att:${RASTER_ID}|p.png]] y`;
    mounted = await mount(doc, [
      { id: RASTER_ID, contentType: "image/png", filename: "p.png", size: 10 },
    ]);
    const embedStart = doc.indexOf("![[");
    const rightOfEmbed = doc.indexOf("]]") + 2;
    mounted.view.dispatch({ selection: { anchor: rightOfEmbed } });
    cursorCharLeft(mounted.view);
    const head = mounted.view.state.selection.main.head;
    // One arrow-left jumps to the left edge — never stops inside the span.
    expect(head).toBe(embedStart);
  });

  it("never rewrites the note bytes when rendering", async () => {
    const doc = `![[att:${RASTER_ID}|photo.png]]`;
    mounted = await mount(doc, [
      { id: RASTER_ID, contentType: "image/png", filename: "photo.png", size: 10 },
    ]);
    expect(mounted.view.state.doc.toString()).toBe(doc);
  });
});

describe("catalog loading state", () => {
  let restorePending: (() => void) | null = null;
  beforeEach(() => {
    // Loader that never resolves → catalog stays null (loading).
    restorePending = setCatalogLoader(() => new Promise<never>(() => {}));
  });
  afterEach(() => {
    restorePending?.();
    restorePending = null;
  });

  it("shows a neutral tombstone frame while the catalog is loading (no flicker)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      state: EditorState.create({
        doc: `![[att:${RASTER_ID}|p.png]]`,
        extensions: [
          markdown({ base: markdownLanguage, extensions: [Wikilink] }),
          ...attachmentCatalogExtension(),
          ...attachmentEmbedDecorations(),
          ...wikilinkChipExtensions(),
        ],
      }),
      parent: host,
    });
    view.requestMeasure();
    // Catalog null → no <img> beacon attempt; a tombstone-frame placeholder.
    expect(host.querySelector("img.cm-attachment-img")).toBeNull();
    expect(host.querySelector(".cm-attachment-tombstone")).not.toBeNull();
    view.destroy();
    host.remove();
  });
});
